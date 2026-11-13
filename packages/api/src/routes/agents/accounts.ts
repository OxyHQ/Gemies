/**
 * A gemie's connected accounts (ADR 0035): the WhatsApp and Telegram accounts a person links to ONE
 * gemie, which answers what arrives on them and is the only gemie whose turns can use them.
 *
 * Managed under the gemie, by whoever may act as it (`loadAgentForAccounts`: the same check as
 * `PATCH /agents/:id`, and for Alia, the person's own assistant, every person). Every read is scoped
 * to the caller as well as the gemie, so a person only ever sees the accounts they linked.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { AgentRecord } from '../../db/agents/agentRepository.js';
import { getDb } from '../../db/index.js';
import {
  createPendingConnectedAccount,
  deleteConnectedAccount,
  findGemieAccount,
  listGemieAccounts,
  setConnectedAccountSession,
  setConnectedAccountStatus,
  type ConnectedAccountRow,
  type GemieAccountScope,
} from '../../db/integrations/connectedAccountRepository.js';
import {
  CONNECTED_ACCOUNT_PLATFORMS,
  CONNECTED_ACCOUNT_STATUSES,
} from '../../db/schema/integrations.js';
import { loadAgentForAccounts, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import {
  bindAccountTask,
  connectPath,
  endAccountSession,
  revokeAccountTask,
  sessionPath,
} from '../../lib/gemie-accounts.js';
import { integrationsFetch } from '../../lib/integrations-client.js';
import { log } from '../../lib/logger.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

/** What the integrations service answers for a session, as far as this router reads it. */
interface IntegrationSessionReply {
  sessionId?: string;
  status?: string;
  qr?: string | null;
  phoneNumber?: string;
  displayName?: string;
  accountId?: string;
  [key: string]: unknown;
}

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

function integrationsConfigured(res: Response): boolean {
  if (process.env.INTEGRATIONS_URL) return true;
  res.status(503).json({ error: 'Integrations service not configured' });
  return false;
}

// GET /agents/:id/accounts — the caller's accounts on this gemie.
router.get('/:id/accounts', authenticateToken, async (req: Request, res: Response) => {
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;
    res.json({ accounts: await listGemieAccounts(getDb(), caller.scope) });
  } catch (err: unknown) {
    log.channels.error({ err }, 'List gemie accounts failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const connectSchema = z.object({ platform: z.enum(CONNECTED_ACCOUNT_PLATFORMS) }).strict();

// POST /agents/:id/accounts { platform } — link a new account; answers its first QR code.
router.post('/:id/accounts', authenticateToken, async (req: Request, res: Response) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Unsupported platform' });
  const { platform } = parsed.data;
  if (!integrationsConfigured(res)) return;

  const db = getDb();
  let account: ConnectedAccountRow | null = null;
  try {
    const caller = await callerOf(req, res);
    if (!caller) return;

    account = await createPendingConnectedAccount(db, {
      ...caller.scope,
      platform,
      capabilities: ['read_messages', 'send_messages'],
    });
    await bindAccountTask({
      account,
      gemie: caller.gemie,
      personAccountId: caller.scope.oxyUserId,
      accessToken: caller.accessToken,
    });

    const response = await integrationsFetch(caller.scope.oxyUserId, connectPath(platform), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oxyUserId: caller.scope.oxyUserId, accountId: account.id }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (response.headers.get('content-type') ?? '').includes('application/json')
      ? ((await response.json()) as IntegrationSessionReply)
      : null;

    if (!response.ok || !data?.sessionId) {
      await revokeAccountTask(account);
      await deleteConnectedAccount(db, account.id);
      return res.status(502).json({ error: `Could not connect ${platform}` });
    }
    await setConnectedAccountSession(db, account.id, data.sessionId);
    res.status(201).json({ accountId: account.id, status: data.status, qr: data.qr ?? null });
  } catch (err: unknown) {
    log.channels.error({ err, platform }, 'Connect gemie account failed');
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
    if (!res.headersSent) res.status(502).json({ error: `Could not connect ${platform}` });
  }
});

/**
 * GET /agents/:id/accounts/:accountId/status — the stored account, synced with its live session.
 * A reply that omits a field never erases the stored one, and only a status the column can hold is
 * stored: the reply is another service's JSON.
 */
router.get(
  '/:id/accounts/:accountId/status',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const found = await accountOf(req, res);
      if (!found) return;
      const { caller, account } = found;
      if (!account.sessionId || !process.env.INTEGRATIONS_URL) return res.json({ account });

      let live: IntegrationSessionReply | null = null;
      try {
        const response = await integrationsFetch(
          caller.scope.oxyUserId,
          `${sessionPath(account.platform, account.sessionId)}/status`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (response.ok) live = (await response.json()) as IntegrationSessionReply;
      } catch {
        // The stored status answers.
      }
      if (!live) return res.json({ account });

      const liveStatus = CONNECTED_ACCOUNT_STATUSES.find((known) => known === live.status);
      if (!liveStatus || liveStatus === account.status) return res.json({ account });
      const becameConnected = liveStatus === 'connected' && !account.connectedAt;
      const synced = await setConnectedAccountStatus(getDb(), account.id, {
        status: liveStatus,
        phoneNumber: live.phoneNumber || undefined,
        displayName: live.displayName || undefined,
        ...(becameConnected
          ? {
              connectedAt: new Date(),
              accountId: live.phoneNumber || live.accountId || account.accountId,
            }
          : {}),
      });
      res.json({ account: synced ?? account });
    } catch (err: unknown) {
      log.channels.error({ err }, 'Gemie account status failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /agents/:id/accounts/:accountId/qr — the session's current QR code, while it awaits a scan.
router.get(
  '/:id/accounts/:accountId/qr',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      if (!integrationsConfigured(res)) return;
      const found = await accountOf(req, res);
      if (!found) return;
      const { caller, account } = found;
      if (!account.sessionId) return res.status(404).json({ error: 'No active session' });
      const response = await integrationsFetch(
        caller.scope.oxyUserId,
        `${sessionPath(account.platform, account.sessionId)}/qr`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const data = (await response.json()) as IntegrationSessionReply;
      res.status(response.status).json({ status: data.status, qr: data.qr ?? null });
    } catch (err: unknown) {
      log.channels.warn({ err }, 'Gemie account QR failed');
      res.status(502).json({ error: 'Could not read the QR code' });
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
      log.channels.error({ err }, 'Delete gemie account failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
