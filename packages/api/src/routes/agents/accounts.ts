/**
 * A gemie's connected accounts (ADR 0035): the WhatsApp and Telegram accounts a person links to ONE
 * gemie, which answers what arrives on them (as their replies say) and is the only gemie whose
 * turns can use them.
 *
 * Managed under the gemie, by whoever may act as it (`loadAgentForAccounts`: the same check as
 * `PATCH /agents/:id`, and for Alia, the person's own assistant, every person). Every read is scoped
 * to the caller as well as the gemie, so a person only ever sees the accounts they linked.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { GEMIE_ACCOUNT_PLATFORMS } from '@gemies/server/internal';
import type { AgentRecord } from '../../db/agents/agentRepository.js';
import { getDb } from '../../db/index.js';
import {
  createPendingConnectedAccount,
  deleteConnectedAccount,
  findGemieAccount,
  listGemieAccounts,
  setConnectedAccountReplies,
  setConnectedAccountSession,
  type ConnectedAccountRow,
  type GemieAccountScope,
} from '../../db/integrations/connectedAccountRepository.js';
import {
  CONNECTED_ACCOUNT_GROUP_REPLIES,
  CONNECTED_ACCOUNT_REPLIES,
} from '../../db/schema/integrations.js';
import { loadAgentForAccounts, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import {
  availablePlatforms,
  bindAccountTask,
  endAccountSession,
  GatewayError,
  listAccountChats,
  openAccountSession,
  readAccountQr,
  revokeAccountTask,
  syncAccountSession,
} from '../../lib/gemie-accounts.js';
import { log } from '../../lib/logger.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

interface Caller {
  readonly gemie: AgentRecord;
  readonly scope: GemieAccountScope;
  readonly accessToken: string;
}

/** The gemie and the caller's scope on it, or an answer already sent. */
async function callerOf(req: Request, res: Response): Promise<Caller | null> {
  if (!req.user?.id || !req.accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const loaded = await loadAgentForAccounts(getDb(), {
    agentId: String(req.params.id),
    oxyUserId: req.user.id,
    accessToken: req.accessToken,
  });
  if (!loaded.ok) {
    res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal)).json({
      error:
        loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal),
    });
    return null;
  }
  return {
    gemie: loaded.agent,
    scope: { agentId: loaded.agent._id, oxyUserId: req.user.id },
    accessToken: req.accessToken,
  };
}

/** One of the caller's accounts on the gemie, or an answer already sent. */
async function accountOf(
  req: Request,
  res: Response,
): Promise<{ caller: Caller; account: ConnectedAccountRow } | null> {
  const caller = await callerOf(req, res);
  if (!caller) return null;
  const account = await findGemieAccount(getDb(), String(req.params.accountId), caller.scope);
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  return { caller, account };
}

/**
 * A failure as the panel reads it: `{ error, code }`. A gateway that could not be reached or refused
 * is `503 accounts_gateway_unavailable` with what it said — never a `502`, which a CDN serves
 * without the API's CORS headers and a browser reports as an opaque network error, so the panel
 * could neither read nor show it.
 */
function answerFailure(res: Response, err: unknown, what: string): void {
  if (res.headersSent) return;
  if (err instanceof GatewayError) {
    res.status(503).json({ error: err.message, code: 'accounts_gateway_unavailable' });
    return;
  }
  log.channels.error({ err }, `${what} failed`);
  res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
}

/**
 * GET /agents/:id/accounts — the caller's accounts on this gemie, each as its session is now, and
 * the platforms this deployment can link (only those are offered).
 */
router.get('/:id/accounts', authenticateToken, async (req: Request, res: Response) => {
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    const [stored, platforms] = await Promise.all([
      listGemieAccounts(getDb(), caller.scope),
      availablePlatforms(caller.scope.oxyUserId),
    ]);
    const accounts = await Promise.all(
      stored.map((account) => syncAccountSession(account, caller.scope.oxyUserId)),
    );
    res.json({ accounts, platforms });
  } catch (err: unknown) {
    answerFailure(res, err, 'Listing gemie accounts');
  }
});

const linkSchema = z.object({ platform: z.enum(GEMIE_ACCOUNT_PLATFORMS) }).strict();

// POST /agents/:id/accounts { platform } — link a new account; answers its first QR code.
router.post('/:id/accounts', authenticateToken, async (req: Request, res: Response) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Unsupported platform' });
  const { platform } = parsed.data;

  const db = getDb();
  let account: ConnectedAccountRow | null = null;
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    if (!(await availablePlatforms(caller.scope.oxyUserId)).includes(platform)) {
      return res
        .status(409)
        .json({ error: `${platform} cannot be linked here`, code: 'platform_unavailable' });
    }

    account = await createPendingConnectedAccount(db, { ...caller.scope, platform });
    await bindAccountTask({
      account,
      gemie: caller.gemie,
      personAccountId: caller.scope.oxyUserId,
      accessToken: caller.accessToken,
    });
    const link = await openAccountSession(platform, caller.scope.oxyUserId);
    await setConnectedAccountSession(db, account.id, link.sessionId);
    res.status(201).json({ accountId: account.id, qr: link.qr });
  } catch (err: unknown) {
    if (account) {
      const orphan = account;
      await revokeAccountTask(orphan)
        .then(() => deleteConnectedAccount(db, orphan.id))
        .catch((cleanupErr: unknown) =>
          log.channels.warn(
            { err: cleanupErr, accountId: orphan.id },
            'Pending account cleanup will require retry',
          ),
        );
    }
    answerFailure(res, err, `Linking ${platform}`);
  }
});

const repliesSchema = z
  .object({
    replies: z.enum(CONNECTED_ACCOUNT_REPLIES).optional(),
    replyChatIds: z.array(z.string().min(1).max(200)).max(200).optional(),
    groupReplies: z.enum(CONNECTED_ACCOUNT_GROUP_REPLIES).optional(),
  })
  .strict();

// PATCH /agents/:id/accounts/:accountId — who the gemie answers on the account.
router.patch('/:id/accounts/:accountId', authenticateToken, async (req: Request, res: Response) => {
  const parsed = repliesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid replies' });
  try {
    const found = await accountOf(req, res);
    if (!found) return;
    const account = await setConnectedAccountReplies(
      getDb(),
      found.account.id,
      found.caller.scope,
      parsed.data,
    );
    res.json({ account });
  } catch (err: unknown) {
    answerFailure(res, err, 'Updating account replies');
  }
});

// GET /agents/:id/accounts/:accountId/qr — the session's current code, while it awaits a scan.
router.get(
  '/:id/accounts/:accountId/qr',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const found = await accountOf(req, res);
      if (!found) return;
      if (!found.account.sessionId) return res.status(404).json({ error: 'No active session' });
      res.json(await readAccountQr(found.account, found.caller.scope.oxyUserId));
    } catch (err: unknown) {
      answerFailure(res, err, 'Reading an account QR');
    }
  },
);

// GET /agents/:id/accounts/:accountId/chats — its recent chats, to choose which ones it answers.
router.get(
  '/:id/accounts/:accountId/chats',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const found = await accountOf(req, res);
      if (!found) return;
      if (found.account.status !== 'connected') return res.json({ chats: [] });
      res.json({ chats: await listAccountChats(found.account, found.caller.scope.oxyUserId) });
    } catch (err: unknown) {
      answerFailure(res, err, 'Listing account chats');
    }
  },
);

// POST /agents/:id/accounts/:accountId/reauthorize — renew the account's task, no new provider link.
router.post(
  '/:id/accounts/:accountId/reauthorize',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const found = await accountOf(req, res);
      if (!found) return;
      const { caller, account } = found;
      await revokeAccountTask(account);
      await bindAccountTask({
        account,
        gemie: caller.gemie,
        personAccountId: caller.scope.oxyUserId,
        accessToken: caller.accessToken,
      });
      res.json({ success: true, oxyTaskState: 'active' });
    } catch (err: unknown) {
      log.channels.error({ err }, 'Channel task renewal failed');
      res.status(503).json({ error: 'Could not resume channel tools' });
    }
  },
);

// DELETE /agents/:id/accounts/:accountId — end the session, revoke the task, forget the account.
router.delete(
  '/:id/accounts/:accountId',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const found = await accountOf(req, res);
      if (!found) return;
      const { caller, account } = found;
      await revokeAccountTask(account);
      await endAccountSession(account, caller.scope.oxyUserId);
      await deleteConnectedAccount(getDb(), account.id);
      res.json({ success: true });
    } catch (err: unknown) {
      answerFailure(res, err, 'Removing a gemie account');
    }
  },
);

export default router;
