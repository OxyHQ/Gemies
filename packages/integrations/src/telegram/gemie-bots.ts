/**
 * Each gemie's own Telegram bot (ADR 0037): its owner pastes a @BotFather token in the gemie's
 * editor, and people talk to the gemie there, alone or in groups.
 *
 * The API keeps the bots and their tokens (encrypted, `bots`) and decides every answer: who pays,
 * which conversation it is, and whether a group message is the gemie's to answer. This module is
 * the Telegram side of it: setting a bot up (profile and webhook), and turning the messages it
 * receives into the API's question and the API's answer into a Telegram message.
 */

import { Router, type Request, type Response } from 'express';
import { APIClient, type TelegramBotMessage } from '../shared/api-client';
import { createLogger } from '../shared/logger';
import { BotApi, TelegramApiError, looksLikeBotToken } from './bot-api';
import { GEMIE_BOT_UPDATES, registerWebhook } from './bots';
import { sendText, whileTyping } from './send';
import type { TelegramMessage, TelegramUpdate } from './types';
import { webhookUrl } from './webhook';

const logger = createLogger('telegram/gemie-bots');
const apiClient = new APIClient('telegram');

/** A gemie's bot as this process knows it: its client and its @username. */
interface GemieBot {
  api: BotApi;
  username: string;
}

const known = new Map<string, GemieBot>();
let lastRefresh = 0;
/** A bot the cache does not know is asked for again at most this often. */
const REFRESH_ON_MISS_MS = 30_000;

/** Read every gemie's bot from the API, replacing what was known. */
export async function refreshGemieBots(): Promise<GemieBot[]> {
  const bots = await apiClient.listTelegramBots();
  known.clear();
  for (const bot of bots) {
    known.set(bot.botId, { api: new BotApi(bot.token), username: bot.username });
  }
  lastRefresh = Date.now();
  return [...known.values()];
}

/** The gemie bot with this id, asking the API again when it is not known yet. */
export async function findGemieBot(botId: string): Promise<GemieBot | null> {
  const bot = known.get(botId);
  if (bot) return bot;
  if (Date.now() - lastRefresh < REFRESH_ON_MISS_MS) return null;
  await refreshGemieBots();
  return known.get(botId) ?? null;
}

/** Whether a message is addressed to the bot: a mention, a command naming it, or a reply to it. */
export function mentionsBot(message: TelegramMessage, bot: { id: string; username: string }) {
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = `@${bot.username}`.toLowerCase();
  const named = entities.some((entity) => {
    const span = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (entity.type === 'mention') return span === handle;
    if (entity.type === 'text_mention') return String(entity.user?.id) === bot.id;
    if (entity.type === 'bot_command') return span.endsWith(handle);
    return false;
  });
  return named || String(message.reply_to_message?.from?.id) === bot.id;
}

/** The text the gemie reads: without the bot's @handle and without a leading `/command@bot`. */
export function textForGemie(text: string, username: string): string {
  const handle = new RegExp(`@${username}\\b`, 'gi');
  return text
    .replace(/^\/[A-Za-z0-9_]+(@\w+)?\s*/, (command) =>
      /^\/start\b/i.test(command) ? command : '',
    )
    .replace(handle, '')
    .trim();
}

/** Answer one update of a gemie's bot. */
export async function handleGemieBotUpdate(bot: GemieBot, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.from || message.from.is_bot) return;
  const raw = message.text ?? message.caption ?? '';
  if (!raw) return;
  const chatKind =
    message.chat.type === 'private'
      ? ('direct' as const)
      : message.chat.type === 'group' || message.chat.type === 'supergroup'
        ? ('group' as const)
        : null;
  if (!chatKind) return;
  const addressed = mentionsBot(message, { id: bot.api.botId, username: bot.username });
  // A group message that is not the bot's is never the gemie's to answer, whatever the setting.
  if (chatKind === 'group' && !addressed) return;
  const text = textForGemie(raw, bot.username);
  if (!text) return;

  const chatId = String(message.chat.id);
  const question: TelegramBotMessage = {
    chatId,
    chatKind,
    chatTitle: message.chat.title ?? null,
    messageId: String(message.message_id),
    from: {
      id: String(message.from.id),
      username: message.from.username ?? null,
      name: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
    },
    text,
    mentionsBot: addressed,
  };
  const answer = await whileTyping(bot.api, { chatId }, () =>
    apiClient.answerTelegramBotMessage(bot.api.botId, question),
  );
  if (!answer.reply) return;
  await sendText(
    bot.api,
    { chatId, replyToMessageId: chatKind === 'group' ? message.message_id : undefined },
    answer.reply,
  );
}

/** What a bot shows of the gemie: its name, its description and its picture. */
interface BotProfile {
  name: string;
  description: string;
  shortDescription: string;
  /** A JPEG of the gemie's avatar, base64. Telegram accepts only JPEG for a static photo. */
  photoJpegBase64?: string | null;
}

/** Fit a string within Telegram's limit for the field. */
const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

/**
 * Give the bot the gemie's profile. Each part is tried on its own and reported, so a picture
 * Telegram refuses still leaves the name and description set.
 */
async function applyProfile(api: BotApi, profile: BotProfile) {
  const result = { name: false, description: false, photo: false };
  const attempt = async (part: keyof typeof result, run: () => Promise<unknown>) => {
    try {
      await run();
      result[part] = true;
    } catch (error: unknown) {
      logger.warn(`Bot ${api.botId}: setting its ${part} failed:`, error);
    }
  };
  await attempt('name', () => api.call('setMyName', { name: clip(profile.name, 64) }));
  await attempt('description', async () => {
    await api.call('setMyDescription', { description: clip(profile.description, 512) });
    await api.call('setMyShortDescription', {
      short_description: clip(profile.shortDescription, 120),
    });
  });
  if (profile.photoJpegBase64) {
    const bytes = Buffer.from(profile.photoJpegBase64, 'base64');
    await attempt('photo', () =>
      api.upload('setMyProfilePhoto', { photo: { type: 'static', photo: 'attach://avatar' } }, [
        { field: 'avatar', filename: 'avatar.jpg', contentType: 'image/jpeg', bytes },
      ]),
    );
  }
  return result;
}

/** The token a management call names, or an answer already sent. */
function tokenOf(req: Request, res: Response): BotApi | null {
  const token = (req.body as { token?: unknown })?.token;
  if (typeof token !== 'string' || !looksLikeBotToken(token.trim())) {
    res.status(400).json({ error: 'A @BotFather token is required', code: 'invalid_token' });
    return null;
  }
  return new BotApi(token.trim());
}

/** A Telegram refusal as the API reads it: the token is wrong, or Telegram said something else. */
function answerTelegramError(res: Response, error: unknown, what: string) {
  if (error instanceof TelegramApiError && (error.code === 401 || error.code === 404)) {
    res.status(400).json({ error: 'Telegram does not accept this token', code: 'invalid_token' });
    return;
  }
  logger.error(`${what} failed:`, error);
  res.status(502).json({
    error: error instanceof TelegramApiError ? error.description : 'Telegram could not be reached',
    code: 'telegram_unavailable',
  });
}

/**
 * The API's routes for a gemie's bot, mounted at `/telegram/bots` behind the API workload check.
 * The token travels in the body of each call (never in a URL), because the API keeps it.
 */
export function gemieBotsRouter(): Router {
  const router = Router();

  // Check the token, give the bot the gemie's profile and point its webhook here.
  router.post('/setup', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    try {
      const me = await api.getMe();
      if (!me.username) {
        return res.status(400).json({ error: 'This bot has no username', code: 'invalid_token' });
      }
      const profile = await applyProfile(api, req.body.profile as BotProfile);
      await registerWebhook(api, GEMIE_BOT_UPDATES);
      known.set(api.botId, { api, username: me.username });
      res.json({
        botId: api.botId,
        username: me.username,
        name: me.first_name,
        canJoinGroups: me.can_join_groups ?? false,
        canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
        profile,
      });
    } catch (error: unknown) {
      answerTelegramError(res, error, 'Setting a gemie bot up');
    }
  });

  // Give the bot the gemie's profile again (after the gemie changed).
  router.post('/profile', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    try {
      await api.getMe();
      res.json({ profile: await applyProfile(api, req.body.profile as BotProfile) });
    } catch (error: unknown) {
      answerTelegramError(res, error, 'Updating a gemie bot profile');
    }
  });

  // How the bot is now, as Telegram sees it: for the editor's live status.
  router.post('/status', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    try {
      const [me, info] = await Promise.all([api.getMe(), api.getWebhookInfo()]);
      const recentError =
        info.last_error_date && info.last_error_date * 1000 > Date.now() - 60 * 60_000
          ? (info.last_error_message ?? 'Telegram could not deliver')
          : null;
      res.json({
        username: me.username ?? null,
        name: me.first_name,
        canJoinGroups: me.can_join_groups ?? false,
        canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
        webhook: info.url === webhookUrl(api.botId) ? (recentError ? 'failing' : 'ok') : 'missing',
        webhookError: recentError,
        pendingUpdates: info.pending_update_count,
      });
    } catch (error: unknown) {
      answerTelegramError(res, error, 'Reading a gemie bot');
    }
  });

  // Stop the bot's webhook: its gemie no longer answers there. A revoked token is already done.
  router.post('/teardown', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    known.delete(api.botId);
    try {
      await api.deleteWebhook();
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError && (error.code === 401 || error.code === 404))) {
        logger.warn(`Bot ${api.botId}: removing its webhook failed:`, error);
      }
    }
    res.status(204).end();
  });

  return router;
}
