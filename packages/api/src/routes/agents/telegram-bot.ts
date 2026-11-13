/**
 * A gemie's own Telegram bot (ADR 0037), managed in the gemie's editor by whoever may act as the
 * gemie (`loadAgentForActor`, the check of `PATCH /agents/:id`; never Alia, whose identity is
 * Oxy's).
 *
 * The owner pastes a @BotFather token; the bot takes the gemie's name, description and picture, and
 * people talk to the gemie there, alone or in groups. The person who connects it pays for its turns
 * when the gemie cannot, if they allow it, and only they can change that.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { AgentRecord } from '../../db/agents/agentRepository.js';
import { getDb } from '../../db/index.js';
import {
  findGemieBot,
  findGemieBotToken,
  saveGemieBot,
  setGemieBotLinkCode,
  setGemieBotOwnerPays,
  setGemieBotSettings,
  telegramBotTakenByAnother,
  unlinkGemieBotPerson,
  type GemieBotRow,
} from '../../db/integrations/gemieBotRepository.js';
import { BOT_GROUP_REPLIES } from '../../db/schema/bots.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import {
  readTelegramBotStatus,
  releaseGemieTelegramBot,
  setUpTelegramBot,
  tearDownTelegramBot,
  TelegramBotSetupError,
  telegramProfileOf,
  updateTelegramBotProfile,
  type TelegramBotLiveStatus,
} from '../../lib/gemie-telegram-bot-setup.js';
import { oxyActorFor } from '../../lib/gemie-oxy-actor.js';
import { log } from '../../lib/logger.js';
import { createOxyTask, revokeReleasedTask } from '../../lib/oxy-task-authority.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

interface Caller {
  readonly gemie: AgentRecord;
  readonly oxyUserId: string;
  readonly accessToken: string;
}

/** How long the editor's one-time link to the bot works. */
const LINK_CODE_TTL_MS = 15 * 60_000;

/** A link code as stored: only its hash, so the table never holds a usable one. */
export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

async function callerOf(req: Request, res: Response): Promise<Caller | null> {
  if (!req.user?.id || !req.accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const loaded = await loadAgentForActor(getDb(), {
    agentId: String(req.params.id),
    oxyUserId: req.user.id,
    accessToken: req.accessToken,
    cache: false,
  });
  if (!loaded.ok) {
    res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal)).json({
      error:
        loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal),
    });
    return null;
  }
  return { gemie: loaded.agent, oxyUserId: req.user.id, accessToken: req.accessToken };
}

/** The bot as the editor shows it: what is stored, and how Telegram sees it now when it answers. */
function present(bot: GemieBotRow, caller: Caller, live: TelegramBotLiveStatus | null) {
  return {
    botId: bot.botId,
    username: bot.username,
    name: bot.name,
    status: bot.status,
    groupReplies: bot.groupReplies,
    ownerPaysAgentTurns: bot.ownerPaysAgentTurns,
    /** Whether the caller is the person who pays, and so may change `ownerPaysAgentTurns`. */
    callerPays: bot.userId === caller.oxyUserId,
    /**
     * Whether the person who connected it linked their own Telegram, so the gemie recognises them
     * there and their private chat with it is theirs: their tools, memory and authority, as in the
     * app (ADR 0037, amendment). Anybody else on the bot is a third party.
     */
    personLinked: bot.linkedTelegramUserId !== null && bot.oxyTaskId !== null,
    totalMessages: bot.totalMessages,
    lastMessageAt: bot.lastMessageAt,
    live,
  };
}

function answerFailure(res: Response, err: unknown, what: string): void {
  if (res.headersSent) return;
  if (err instanceof TelegramBotSetupError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  log.channels.error({ err }, `${what} failed`);
  res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
}

/** The live status, or `null` when Telegram or the service cannot be asked now. */
async function liveStatus(agentId: string): Promise<TelegramBotLiveStatus | null> {
  const token = await findGemieBotToken(getDb(), agentId);
  if (!token) return null;
  return readTelegramBotStatus(token).catch(() => null);
}

/** A JPEG of the gemie's avatar, base64, drawn by the editor: Telegram takes only JPEG. */
const photoSchema = z
  .string()
  .max(1_500_000)
  .regex(/^[A-Za-z0-9+/=]+$/)
  .nullish();

// GET /agents/:id/telegram-bot — the gemie's bot, or none; and whether one can be connected here.
router.get('/:id/telegram-bot', authenticateToken, async (req: Request, res: Response) => {
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    const available = Boolean(process.env.INTEGRATIONS_URL);
    const bot = await findGemieBot(getDb(), caller.gemie._id);
    if (!bot) return res.json({ bot: null, available });
    res.json({ bot: present(bot, caller, await liveStatus(bot.agentId)), available });
  } catch (err: unknown) {
    answerFailure(res, err, 'Reading a gemie bot');
  }
});

const connectSchema = z
  .object({
    token: z.string().trim().min(10).max(200),
    ownerPaysAgentTurns: z.boolean(),
    photoJpegBase64: photoSchema,
  })
  .strict();

// PUT /agents/:id/telegram-bot { token, ownerPaysAgentTurns, photoJpegBase64? } — connect a bot,
// or replace the one the gemie had.
router.put('/:id/telegram-bot', authenticateToken, async (req: Request, res: Response) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'A @BotFather token is required', code: 'invalid_token' });
  }
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    const db = getDb();
    const { token, ownerPaysAgentTurns, photoJpegBase64 } = parsed.data;
    const botId = token.slice(0, token.indexOf(':'));
    if (botId && (await telegramBotTakenByAnother(db, botId, caller.gemie._id))) {
      return res
        .status(409)
        .json({ error: 'This bot already belongs to another gemie', code: 'bot_taken' });
    }
    const previousToken = await findGemieBotToken(db, caller.gemie._id);
    const setup = await setUpTelegramBot(
      token,
      await telegramProfileOf(caller.gemie, photoJpegBase64),
    );
    const { bot, released } = await saveGemieBot(db, {
      agentId: caller.gemie._id,
      userId: caller.oxyUserId,
      botId: setup.botId,
      name: setup.name,
      username: setup.username,
      botToken: token,
      ownerPaysAgentTurns,
    });
    // A bot it replaced stops answering for the gemie, and its person's link goes with it.
    await revokeReleasedTask(released);
    if (previousToken && previousToken.split(':')[0] !== setup.botId) {
      await tearDownTelegramBot(previousToken);
    }
    res.status(201).json({
      bot: present(bot, caller, {
        username: setup.username,
        name: setup.name,
        canJoinGroups: setup.canJoinGroups,
        canReadAllGroupMessages: setup.canReadAllGroupMessages,
        webhook: 'ok',
        webhookError: null,
        pendingUpdates: 0,
      }),
      profile: setup.profile,
    });
  } catch (err: unknown) {
    answerFailure(res, err, 'Connecting a gemie bot');
  }
});

const settingsSchema = z
  .object({
    groupReplies: z.enum(BOT_GROUP_REPLIES).optional(),
    ownerPaysAgentTurns: z.boolean().optional(),
    /** Give the bot the gemie's name, description and picture again. */
    syncProfile: z.boolean().optional(),
    photoJpegBase64: photoSchema,
  })
  .strict();

// PATCH /agents/:id/telegram-bot — its settings, or its profile taken from the gemie again.
router.patch('/:id/telegram-bot', authenticateToken, async (req: Request, res: Response) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid settings' });
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    const db = getDb();
    const agentId = caller.gemie._id;
    let bot = await findGemieBot(db, agentId);
    if (!bot) return res.status(404).json({ error: 'This gemie has no Telegram bot' });
    const { groupReplies, ownerPaysAgentTurns, syncProfile, photoJpegBase64 } = parsed.data;
    if (ownerPaysAgentTurns !== undefined) {
      // Consent to be charged is the payer's own.
      if (bot.userId !== caller.oxyUserId) {
        return res.status(403).json({
          error: 'Only the person who connected the bot decides whether their credits pay for it',
        });
      }
      bot = (await setGemieBotOwnerPays(db, agentId, caller.oxyUserId, ownerPaysAgentTurns)) ?? bot;
    }
    if (groupReplies !== undefined) {
      bot = (await setGemieBotSettings(db, agentId, { groupReplies })) ?? bot;
    }
    let profile: { name: boolean; description: boolean; photo: boolean } | undefined;
    if (syncProfile) {
      const token = await findGemieBotToken(db, agentId);
      if (token) {
        const updated = await updateTelegramBotProfile(
          token,
          await telegramProfileOf(caller.gemie, photoJpegBase64),
        );
        profile = updated.profile;
      }
    }
    res.json({ bot: present(bot, caller, await liveStatus(agentId)), profile });
  } catch (err: unknown) {
    answerFailure(res, err, 'Updating a gemie bot');
  }
});

/** Only the person who connected the bot: its chats are kept for them, and only they may be it there. */
function personOnly(bot: GemieBotRow, caller: Caller, res: Response): boolean {
  if (bot.userId === caller.oxyUserId) return true;
  res.status(403).json({
    error: 'Only the person who connected the bot can link their Telegram to it',
    code: 'not_bot_person',
  });
  return false;
}

// POST /agents/:id/telegram-bot/link — a one-time link that tells the bot which Telegram account is
// the caller's. It also grants the gemie the caller's authority for their own turns there (a durable
// Oxy task, minted now, while their session is present). Open it in Telegram: `/start <code>`.
router.post('/:id/telegram-bot/link', authenticateToken, async (req: Request, res: Response) => {
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    const db = getDb();
    const bot = await findGemieBot(db, caller.gemie._id);
    if (!bot?.username) return res.status(404).json({ error: 'This gemie has no Telegram bot' });
    if (!personOnly(bot, caller, res)) return;
    const oxyTaskId = await createOxyTask({
      accessToken: caller.accessToken,
      effectiveAccountId: caller.oxyUserId,
      actor: oxyActorFor(caller.gemie, caller.oxyUserId),
      origin: { kind: 'automation', id: `channel:${bot.id}` },
    });
    const code = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
    const saved = await setGemieBotLinkCode(db, {
      agentId: caller.gemie._id,
      userId: caller.oxyUserId,
      codeHash: hashLinkCode(code),
      expiresAt,
      oxyTaskId,
    }).catch(async (error: unknown) => {
      await revokeReleasedTask(oxyTaskId);
      throw error;
    });
    if (!saved) {
      await revokeReleasedTask(oxyTaskId);
      return res.status(409).json({ error: 'The bot changed; try again' });
    }
    await revokeReleasedTask(saved.replaced);
    res.json({ url: `https://t.me/${bot.username}?start=${code}`, expiresAt });
  } catch (err: unknown) {
    answerFailure(res, err, 'Linking a Telegram account to a gemie bot');
  }
});

// DELETE /agents/:id/telegram-bot/link — the bot stops recognising the caller's Telegram, and the
// authority it held is revoked. The bot keeps answering everybody as a third party.
router.delete('/:id/telegram-bot/link', authenticateToken, async (req: Request, res: Response) => {
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    const db = getDb();
    const bot = await findGemieBot(db, caller.gemie._id);
    if (!bot) return res.status(404).json({ error: 'This gemie has no Telegram bot' });
    if (!personOnly(bot, caller, res)) return;
    const unlinked = await unlinkGemieBotPerson(db, caller.gemie._id, caller.oxyUserId);
    await revokeReleasedTask(unlinked?.released ?? null);
    res.json({ bot: present(unlinked?.bot ?? bot, caller, await liveStatus(bot.agentId)) });
  } catch (err: unknown) {
    answerFailure(res, err, 'Unlinking a Telegram account from a gemie bot');
  }
});

// DELETE /agents/:id/telegram-bot — the gemie stops answering there; the bot itself stays the
// owner's, in @BotFather.
router.delete('/:id/telegram-bot', authenticateToken, async (req: Request, res: Response) => {
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    await releaseGemieTelegramBot(caller.gemie._id);
    res.json({ success: true });
  } catch (err: unknown) {
    answerFailure(res, err, 'Removing a gemie bot');
  }
});

export default router;
