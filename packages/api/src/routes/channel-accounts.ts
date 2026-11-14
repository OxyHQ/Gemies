/**
 * What the integrations gateway asks of a connected account it serves (ADR 0035), over a verified
 * channel: the account, and the gemie that answers it, come from the live provider session and the
 * person's grants (`middleware/channel-auth.ts`), never from the request.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import {
  GEMIE_ACCOUNT_STATUSES,
  type GemieAccountInboundDecision,
  type GemieAccountTurnContent,
  turnContentText,
} from '@gemies/server/internal';
import { channelMessageSchema, prepareChannelTurn } from '../lib/channel-messages.js';
import { appendConversationMessages } from '../lib/conversation-saver.js';
import type { MessageContent } from '../domain/conversation.js';
import { getDb } from '../db/index.js';
import {
  findConnectedAccount,
  setConnectedAccountSessionState,
  touchConnectedAccount,
} from '../db/integrations/connectedAccountRepository.js';
import { shouldAnswer } from '../lib/connected-accounts.js';
import { log } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';
import { publishConnectionsChanged } from '../lib/realtime/account.js';

const router = Router();

const inboundSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    chatKind: z.enum(['direct', 'group']),
    mentionsAccount: z.boolean(),
  })
  .strict();

/**
 * POST /channel-accounts/inbound — a message arrived on the account: record it, and say whether
 * it is answered: only when a gemie answers the account and the account's replies cover it.
 */
router.post('/inbound', authenticateToken, async (req: Request, res: Response) => {
  const context = req.channelContext;
  if (context?.kind !== 'account') {
    return res.status(403).json({ error: 'A connected account channel is required' });
  }
  const parsed = inboundSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid inbound message' });
  try {
    const account = await findConnectedAccount(getDb(), context.identityId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await touchConnectedAccount(getDb(), account.id);
    const decision: GemieAccountInboundDecision = {
      answer: typeof context.gemieId === 'string' && shouldAnswer(account, parsed.data),
    };
    res.json(decision);
  } catch (err: unknown) {
    log.channels.error({ err }, 'Inbound decision failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const incomingSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    message: channelMessageSchema,
    conversationId: z.string().min(1).max(128).optional(),
    messageId: z.string().min(1).max(256).optional(),
  })
  .strict();

/**
 * POST /channel-accounts/messages — a message the account's gemie will answer, as its turn carries
 * it: its media kept in the person's Oxy Files and its voice transcribed on their account, both
 * theirs, as an attachment they made in the app would be (`lib/channel-messages.ts`).
 */
router.post('/messages', authenticateToken, async (req: Request, res: Response) => {
  const context = req.channelContext;
  if (context?.kind !== 'account' || typeof context.gemieId !== 'string') {
    return res.status(403).json({ error: 'A connected account its gemie answers is required' });
  }
  const parsed = incomingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid message' });
  try {
    // Kept as the person's under the account's task; without one nothing of it is stored.
    const turn = await prepareChannelTurn({
      message: parsed.data.message,
      owner: context.taskId ? { oxyUserId: context.accountId, taskId: context.taskId } : null,
      payerAccountId: context.accountId,
    });
    // Files are read on the turn with the account's task; without one, the turn reads their words.
    const content: GemieAccountTurnContent['content'] = context.taskId
      ? turn.content
      : [{ type: 'text', text: turnContentText(turn.content) }];
    // Kept in its conversation the moment it arrives, so the app shows it before the gemie
    // answers; the turn then appends only its reply (`conversation-saver.ts`).
    const { conversationId, messageId } = parsed.data;
    if (conversationId && messageId) {
      await appendConversationMessages<MessageContent>({
        userId: context.accountId,
        conversationId,
        agentId: context.gemieId,
        titleOnInsert: `${context.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'} · ${parsed.data.chatId}`,
        source: context.platform === 'whatsapp' ? 'whatsapp' : 'telegram',
        messages: [{ id: messageId, role: 'user', content: [...content] }],
      });
    }
    res.json({ content } satisfies GemieAccountTurnContent);
  } catch (err: unknown) {
    log.channels.error({ err }, 'A connected account message could not be prepared');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const sessionSchema = z
  .object({
    status: z.enum(GEMIE_ACCOUNT_STATUSES),
    phoneNumber: z.string().max(64).nullish(),
    displayName: z.string().max(256).nullish(),
    canReply: z.boolean().nullish(),
  })
  .strict();

/**
 * POST /channel-accounts/session — the account's provider session moved (Telegram reported the
 * connection turned off or on again, or its rights changed): stored now, so its gemies' tools and
 * the panel follow it with nobody opening Gemies.
 */
router.post('/session', authenticateToken, async (req: Request, res: Response) => {
  const context = req.channelContext;
  if (context?.kind !== 'account') {
    return res.status(403).json({ error: 'A connected account channel is required' });
  }
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid session' });
  try {
    const account = await setConnectedAccountSessionState(getDb(), context.identityId, parsed.data);
    // The panel showing it follows at once: a WhatsApp code that was scanned, a session that ended.
    if (account) void publishConnectionsChanged(account.oxyUserId);
    res.status(204).end();
  } catch (err: unknown) {
    log.channels.error({ err }, 'Storing an account session failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
