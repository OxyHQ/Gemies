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
import { answerGemieTelegramMessage } from '../lib/gemie-telegram-bot.js';
import { log } from '../lib/logger.js';
import { authenticateIntegrations } from '../middleware/channel-auth.js';

const router = Router();

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
    try {
      res.json(
        (await answerGemieTelegramMessage(bot, parsed.data)) satisfies GemieTelegramBotAnswer,
      );
    } catch (err: unknown) {
      // Said in the chat rather than retried: a turn half-run could otherwise answer twice.
      log.channels.error({ err, botId: bot.botId }, 'A gemie bot turn failed');
      res.json({
        reply: 'Sorry, something went wrong. Please try again.',
      } satisfies GemieTelegramBotAnswer);
    }
  },
);

export default router;
