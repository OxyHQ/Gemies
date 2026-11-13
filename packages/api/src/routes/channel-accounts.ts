/**
 * What the integrations gateway asks of a connected account it serves (ADR 0035), over a verified
 * channel: the account, and the gemie that answers it, come from the live provider session and the
 * person's grants (`middleware/channel-auth.ts`), never from the request.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { GEMIE_ACCOUNT_STATUSES, type GemieAccountInboundDecision } from '@gemies/server/internal';
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
