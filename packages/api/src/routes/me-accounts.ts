/**
 * `/me/accounts` — the caller's connected accounts (ADR 0035 as amended): the WhatsApp and Telegram
 * accounts a person connects ONCE, in Settings, and grants to the gemies that may use them.
 *
 * - **Grants** (`PUT|DELETE /me/accounts/:accountId/gemies/:gemieId`): which of the person's gemies
 *   may read and send through the account, when the person asks them or their tasks need it. Alia
 *   is granted like any other gemie. A person may grant only a gemie they may act as, or Alia
 *   (`loadGrantableGemie`).
 * - **The answering gemie** (`PATCH { answeringGemieId }`): at most ONE granted gemie replies on its
 *   own to what arrives on the account, as its replies say (`replies`, `replyChatIds`,
 *   `groupReplies`); `null` is none, and then nothing is answered.
 *
 * Every route is the caller's own: an account of anybody else answers 404.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { GEMIE_ACCOUNT_PLATFORMS } from '@gemies/server/internal';
import { listActiveAgentsByAuthor } from '../db/agents/agentRepository.js';
import { getDb } from '../db/index.js';
import {
  createPendingConnectedAccount,
  deleteConnectedAccount,
  findAnsweringGemieId,
  findPersonAccount,
  grantConnectedAccount,
  listPersonAccountGrants,
  listPersonAccounts,
  revokeConnectedAccountGrant,
  setConnectedAccountReplies,
  setConnectedAccountSession,
  type ConnectedAccountGrant,
  type ConnectedAccountRow,
} from '../db/integrations/connectedAccountRepository.js';
import {
  CONNECTED_ACCOUNT_GROUP_REPLIES,
  CONNECTED_ACCOUNT_REPLIES,
} from '../db/schema/integrations.js';
import { ALIA_GEMIE_ID } from '../domain/alia-gemie.js';
import type { StoredAgentIdentity } from '../domain/agent.js';
import { loadGrantableGemie, refusalMessage, refusalStatus } from '../lib/agent-account.js';
import { agentPromptName, attachAgentIdentities } from '../lib/agent-identity.js';
import {
  availablePlatforms,
  bindAccountTask,
  endAccountSession,
  GatewayError,
  listAccountChats,
  openAccountSession,
  readAccountQr,
  revokeAccountTask,
  setAccountAnswering,
  syncAccountSession,
} from '../lib/connected-accounts.js';
import { log } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

interface Caller {
  readonly oxyUserId: string;
  readonly accessToken: string;
}

function callerOf(req: Request, res: Response): Caller | null {
  if (!req.user?.id || !req.accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return { oxyUserId: req.user.id, accessToken: req.accessToken };
}

/** One of the caller's accounts, or an answer already sent. */
async function accountOf(
  req: Request,
  res: Response,
): Promise<{ caller: Caller; account: ConnectedAccountRow } | null> {
  const caller = callerOf(req, res);
  if (!caller) return null;
  const account = await findPersonAccount(getDb(), String(req.params.accountId), caller.oxyUserId);
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  return { caller, account };
}

/** A gemie the caller may grant an account to, or an answer already sent. */
async function grantableGemieOf(res: Response, caller: Caller, agentId: string) {
  const loaded = await loadGrantableGemie(getDb(), { agentId, ...caller });
  if (loaded.ok) return loaded.agent;
  res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal)).json({
    error:
      loaded.refusal === 'agent_not_found' ? 'Gemie not found' : refusalMessage(loaded.refusal),
    code: 'gemie_not_grantable',
  });
  return null;
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

/** An account as the panel reads it: its session, its grants, its answering gemie and its replies. */
function serializeAccount(account: ConnectedAccountRow, grants: readonly ConnectedAccountGrant[]) {
  const { sessionId: _session, oxyTaskId: _task, ...shown } = account;
  const own = grants.filter((grant) => grant.accountId === account.id);
  return {
    ...shown,
    gemieIds: own.map((grant) => grant.agentId),
    answeringGemieId: own.find((grant) => grant.answers)?.agentId ?? null,
  };
}

/**
 * The gemies the panel offers: Alia, the person's own active gemies with an Oxy account, and any
 * other gemie already granted one of their accounts (one they act as, granted from its editor).
 */
async function gemiesOffered(
  oxyUserId: string,
  grants: readonly ConnectedAccountGrant[],
): Promise<{ id: string; name: string }[]> {
  const own = await listActiveAgentsByAuthor(getDb(), oxyUserId);
  const rows = new Map<string, { _id: string; identity: StoredAgentIdentity }>();
  for (const row of [...own, ...grants.map((grant) => ({ _id: grant.agentId, ...grant }))]) {
    if (row._id !== ALIA_GEMIE_ID && row.identity.source === 'oxy' && !rows.has(row._id)) {
      rows.set(row._id, { _id: row._id, identity: row.identity });
    }
  }
  const named = await attachAgentIdentities([...rows.values()]);
  return [
    // Her Oxy account does not exist yet (ADR 0034), so her name is not Oxy's to give.
    { id: ALIA_GEMIE_ID, name: 'Alia' },
    ...named.map((gemie) => ({ id: gemie._id, name: agentPromptName(gemie) })),
  ];
}

/**
 * GET /me/accounts — the caller's accounts, each as its session is now with its grants, the gemies
 * they can be granted to, and the platforms this deployment can connect (only those are offered).
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const caller = callerOf(req, res);
    if (!caller) return;
    const [stored, grants, platforms] = await Promise.all([
      listPersonAccounts(getDb(), caller.oxyUserId),
      listPersonAccountGrants(getDb(), caller.oxyUserId),
      availablePlatforms(caller.oxyUserId),
    ]);
    const [accounts, gemies] = await Promise.all([
      Promise.all(stored.map((account) => syncAccountSession(account, caller.oxyUserId))),
      gemiesOffered(caller.oxyUserId, grants),
    ]);
    res.json({
      accounts: accounts.map((account) => serializeAccount(account, grants)),
      gemies,
      platforms,
    });
  } catch (err: unknown) {
    answerFailure(res, err, 'Listing connected accounts');
  }
});

const connectSchema = z.object({ platform: z.enum(GEMIE_ACCOUNT_PLATFORMS) }).strict();

// POST /me/accounts { platform } — connect a new account; answers its first QR code.
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Unsupported platform' });
  const { platform } = parsed.data;

  const db = getDb();
  let account: ConnectedAccountRow | null = null;
  try {
    const caller = callerOf(req, res);
    if (!caller) return;
    if (!(await availablePlatforms(caller.oxyUserId)).includes(platform)) {
      return res
        .status(409)
        .json({ error: `${platform} cannot be connected here`, code: 'platform_unavailable' });
    }

    account = await createPendingConnectedAccount(db, { oxyUserId: caller.oxyUserId, platform });
    const link = await openAccountSession(platform, caller.oxyUserId);
    await setConnectedAccountSession(db, account.id, link.sessionId);
    res.status(201).json({ accountId: account.id, qr: link.qr });
  } catch (err: unknown) {
    if (account) {
      const orphan = account;
      await deleteConnectedAccount(db, orphan.id).catch((cleanupErr: unknown) =>
        log.channels.warn(
          { err: cleanupErr, accountId: orphan.id },
          'Pending account cleanup will require retry',
        ),
      );
    }
    answerFailure(res, err, `Connecting ${platform}`);
  }
});

const patchSchema = z
  .object({
    answeringGemieId: z.string().min(1).max(200).nullable().optional(),
    replies: z.enum(CONNECTED_ACCOUNT_REPLIES).optional(),
    replyChatIds: z.array(z.string().min(1).max(200)).max(200).optional(),
    groupReplies: z.enum(CONNECTED_ACCOUNT_GROUP_REPLIES).optional(),
  })
  .strict();

/**
 * PATCH /me/accounts/:accountId — who answers it: the answering gemie (granted the account if it
 * was not; `null` for none) and its replies.
 */
router.patch('/:accountId', authenticateToken, async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid account settings' });
  const { answeringGemieId, ...replies } = parsed.data;
  try {
    const found = await accountOf(req, res);
    if (!found) return;
    const { caller, account } = found;
    if (answeringGemieId !== undefined) {
      const gemie =
        answeringGemieId === null ? null : await grantableGemieOf(res, caller, answeringGemieId);
      if (answeringGemieId !== null && gemie === null) return;
      await setAccountAnswering({
        account,
        gemie,
        personAccountId: caller.oxyUserId,
        accessToken: caller.accessToken,
      });
    }
    const stored = Object.keys(replies).length
      ? await setConnectedAccountReplies(getDb(), account.id, caller.oxyUserId, replies)
      : account;
    const grants = await listPersonAccountGrants(getDb(), caller.oxyUserId);
    res.json({ account: serializeAccount(stored ?? account, grants) });
  } catch (err: unknown) {
    answerFailure(res, err, 'Updating a connected account');
  }
});

// PUT /me/accounts/:accountId/gemies/:gemieId — let a gemie use the account.
router.put(
  '/:accountId/gemies/:gemieId',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const found = await accountOf(req, res);
      if (!found) return;
      const gemie = await grantableGemieOf(res, found.caller, String(req.params.gemieId));
      if (!gemie) return;
      await grantConnectedAccount(getDb(), found.account.id, gemie._id);
      res.status(204).end();
    } catch (err: unknown) {
      answerFailure(res, err, 'Granting a connected account');
    }
  },
);

/**
 * DELETE /me/accounts/:accountId/gemies/:gemieId — stop a gemie using the account. Always the
 * person's to do, even for a gemie they no longer act as. When it was the answering gemie, nobody
 * answers the account any more and its task is revoked.
 */
router.delete(
  '/:accountId/gemies/:gemieId',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const found = await accountOf(req, res);
      if (!found) return;
      const { answered } = await revokeConnectedAccountGrant(
        getDb(),
        found.account.id,
        String(req.params.gemieId),
      );
      if (answered) await revokeAccountTask(found.account);
      res.status(204).end();
    } catch (err: unknown) {
      answerFailure(res, err, 'Revoking a connected account grant');
    }
  },
);

// GET /me/accounts/:accountId/qr — the session's current code, while it awaits a scan.
router.get('/:accountId/qr', authenticateToken, async (req: Request, res: Response) => {
  try {
    const found = await accountOf(req, res);
    if (!found) return;
    if (!found.account.sessionId) return res.status(404).json({ error: 'No active session' });
    res.json(await readAccountQr(found.account, found.caller.oxyUserId));
  } catch (err: unknown) {
    answerFailure(res, err, 'Reading an account QR');
  }
});

// GET /me/accounts/:accountId/chats — its recent chats, to choose which ones it answers.
router.get('/:accountId/chats', authenticateToken, async (req: Request, res: Response) => {
  try {
    const found = await accountOf(req, res);
    if (!found) return;
    if (found.account.status !== 'connected') return res.json({ chats: [] });
    res.json({ chats: await listAccountChats(found.account, found.caller.oxyUserId) });
  } catch (err: unknown) {
    answerFailure(res, err, 'Listing account chats');
  }
});

/**
 * POST /me/accounts/:accountId/reauthorize — renew the task its answering gemie acts with, no new
 * provider link. An account nobody answers holds no task: `409 no_answering_gemie`.
 */
router.post('/:accountId/reauthorize', authenticateToken, async (req: Request, res: Response) => {
  try {
    const found = await accountOf(req, res);
    if (!found) return;
    const { caller, account } = found;
    const answeringId = await findAnsweringGemieId(getDb(), account.id);
    if (answeringId === null) {
      return res
        .status(409)
        .json({ error: 'No gemie answers this account', code: 'no_answering_gemie' });
    }
    const gemie = await grantableGemieOf(res, caller, answeringId);
    if (!gemie) return;
    await revokeAccountTask(account);
    await bindAccountTask({
      account,
      gemie,
      personAccountId: caller.oxyUserId,
      accessToken: caller.accessToken,
    });
    res.json({ success: true, oxyTaskState: 'active' });
  } catch (err: unknown) {
    log.channels.error({ err }, 'Channel task renewal failed');
    res.status(503).json({ error: 'Could not resume channel tools' });
  }
});

// DELETE /me/accounts/:accountId — end the session, revoke the task, forget the account and its grants.
router.delete('/:accountId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const found = await accountOf(req, res);
    if (!found) return;
    const { caller, account } = found;
    await revokeAccountTask(account);
    await endAccountSession(account, caller.oxyUserId);
    await deleteConnectedAccount(getDb(), account.id);
    res.json({ success: true });
  } catch (err: unknown) {
    answerFailure(res, err, 'Removing a connected account');
  }
});

export default router;
