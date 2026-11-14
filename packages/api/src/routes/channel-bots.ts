/**
 * What the integrations process asks about gemies' own Telegram bots (ADR 0037), as its verified
 * workload: the bots it speaks as, and the gemie's answer to a message one of them received.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { channelMessageIsEmpty, type GemieTelegramBotAnswer } from '@gemies/server/internal';
import { channelMessageSchema } from '../lib/channel-messages.js';
import { getDb } from '../db/index.js';
import {
  findActiveGemieBotByTelegramId,
  listActiveGemieBotsWithTokens,
} from '../db/integrations/gemieBotRepository.js';
import { answerGemieTelegramMessage, TURN_FAILED_REPLY } from '../lib/gemie-telegram-bot.js';
import { log } from '../lib/logger.js';
import { authenticateIntegrations } from '../middleware/channel-auth.js';

const router = Router();

/** How often a long turn's response sends a byte, well inside the load balancer's idle timeout. */
const KEEP_ALIVE_MS = 15_000;

// GET /channel-bots/telegram — every active gemie bot, with the token to speak as it.
router.get('/telegram', authenticateIntegrations, async (_req: Request, res: Response) => {
  try {
    res.json({ bots: await listActiveGemieBotsWithTokens(getDb()) });
  } catch (err: unknown) {
    log.channels.error({ err }, 'Listing gemie bots failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const messageSchema = z
  .object({
    chatId: z.string().min(1).max(40),
    chatKind: z.enum(['direct', 'group']),
    chatTitle: z.string().max(256).nullable(),
    messageId: z.string().min(1).max(40),
    from: z.object({
      id: z.string().min(1).max(40),
      username: z.string().max(64).nullable(),
      name: z.string().max(256),
      languageCode: z.string().max(35).nullish(),
    }),
    message: channelMessageSchema,
    mentionsBot: z.boolean(),
    edited: z.boolean().optional(),
  })
  .strict();

// POST /channel-bots/telegram/:botId/messages — the gemie's answer, `null` for none, or `personTurn`
// when the bot's person wrote: theirs to run through `/alia/chat` (`lib/gemie-telegram-bot.ts`).
router.post(
  '/telegram/:botId/messages',
  authenticateIntegrations,
  async (req: Request<{ botId: string }>, res: Response) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid message' });
    const bot = await findActiveGemieBotByTelegramId(getDb(), req.params.botId).catch(() => null);
    if (!bot || channelMessageIsEmpty(parsed.data.message)) {
      return res.json({ reply: null } satisfies GemieTelegramBotAnswer);
    }
    // A turn can outlast the load balancer's 60 s idle timeout, which answered the integrations
    // process 504 while the turn went on, and its retry ran the turn again. Whitespace before a
    // JSON body is still that JSON: one space every 15 s keeps the connection open to the end.
    res.status(200).type('application/json');
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(' ');
    }, KEEP_ALIVE_MS);
    let answer: GemieTelegramBotAnswer;
    try {
      answer = await answerGemieTelegramMessage(bot, parsed.data);
    } catch (err: unknown) {
      // Said in the chat rather than retried: the turn keeps this answer, so a retry says it too.
      log.channels.error({ err, botId: bot.botId }, 'A gemie bot turn failed');
      answer = { reply: TURN_FAILED_REPLY };
    } finally {
      clearInterval(keepAlive);
    }
    res.end(JSON.stringify(answer));
  },
);

export default router;
