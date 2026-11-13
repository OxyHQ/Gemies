/**
 * What the integrations gateway asks of a connected account it serves (ADR 0035), over a verified
 * channel: the account comes from the live provider session (`middleware/channel-auth.ts`), never
 * from the request.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { GemieAccountInboundDecision } from '@gemies/server/internal';
import { getDb } from '../db/index.js';
import {
  findConnectedAccount,
  touchConnectedAccount,
} from '../db/integrations/connectedAccountRepository.js';
import { shouldAnswer } from '../lib/gemie-accounts.js';
import { log } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';

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
 * its gemie answers it.
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
    const decision: GemieAccountInboundDecision = { answer: shouldAnswer(account, parsed.data) };
    res.json(decision);
  } catch (err: unknown) {
    log.channels.error({ err }, 'Inbound decision failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
