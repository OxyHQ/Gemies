/**
 * A gemie's connected accounts: the provider sessions behind them, the Oxy authority they carry
 * and who they answer (ADR 0035).
 *
 * A person links a WhatsApp or Telegram account to ONE gemie. The integrations gateway holds the
 * provider session and speaks one contract for every platform (`@gemies/server/internal`); this
 * service holds the row, and with it a durable Oxy task the person granted when linking it, whose
 * actor is the gemie's own (`oxyActorFor`): Alia's lane is the person's own, every other gemie
 * acts as its account. What arrives on the account is answered by that gemie when the account's
 * replies say so (`shouldAnswer`), and only that gemie's turns can use it (`tools/accounts.ts`).
 */

import {
  GEMIE_ACCOUNT_PLATFORMS,
  type GemieAccountChat,
  type GemieAccountInbound,
  type GemieAccountLink,
  type GemieAccountMessage,
  type GemieAccountPlatform,
  type GemieAccountQr,
  type GemieAccountSession,
} from '@gemies/server/internal';
import { getDb } from '../db/index.js';
import {
  listAccountsOfGemie,
  setConnectedAccountSessionState,
  setConnectedAccountTask,
  type ConnectedAccountRow,
} from '../db/integrations/connectedAccountRepository.js';
import { oxyActorFor, type OxyActorGemie } from './gemie-oxy-actor.js';
import { integrationsFetch } from './integrations-client.js';
import { log } from './logger.js';
import { createOxyTask, revokeOxyTask } from './oxy-task-authority.js';

/**
 * A gateway call that did not answer what the contract says: it could not be reached
 * (`status` 0), or it answered with an error (`status` is its own). `message` is what it said, or
 * what happened, in words a person can read.
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

/** Call the gateway as `personAccountId` and read its JSON answer, or throw a `GatewayError`. */
async function gateway<T>(
  personAccountId: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  let response: Response;
  try {
    response = await integrationsFetch(personAccountId, path, {
      ...rest,
      headers: { 'Content-Type': 'application/json', ...rest.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    log.channels.warn({ err, path }, 'The accounts gateway could not be reached');
    throw new GatewayError(0, 'The messaging service could not be reached', path);
  }
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const said =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `The messaging service answered ${response.status}`;
    log.channels.warn({ status: response.status, path, said }, 'The accounts gateway refused');
    throw new GatewayError(response.status, said, path);
  }
  return body as T;
}

const sessionPath = (account: Pick<ConnectedAccountRow, 'platform' | 'sessionId'>) =>
  `/accounts/${account.platform}/sessions/${encodeURIComponent(account.sessionId ?? '')}`;

/** The platform a client named, or `null` when it is not one a gemie can be linked to. */
export function accountPlatformOf(value: unknown): GemieAccountPlatform | null {
  return GEMIE_ACCOUNT_PLATFORMS.find((platform) => platform === value) ?? null;
}

/**
 * The platforms this deployment can link now: the gateways the integrations service runs. None
 * when it is not configured or cannot be asked, so nothing is offered that would fail.
 *
 * It is also the handshake with the gateway's version: a gateway older than this contract has no
 * `/accounts/platforms`, so an API rolled out ahead of its integrations service offers nothing to
 * link until the gateway it calls speaks the same contract.
 */
export async function availablePlatforms(personAccountId: string): Promise<GemieAccountPlatform[]> {
  if (!process.env.INTEGRATIONS_URL) return [];
  try {
    const { platforms } = await gateway<{ platforms: unknown[] }>(
      personAccountId,
      '/accounts/platforms',
      { timeoutMs: 5_000 },
    );
    return GEMIE_ACCOUNT_PLATFORMS.filter((platform) => platforms.includes(platform));
  } catch {
    // `gateway` logged what happened; nothing can be linked until it answers.
    return [];
  }
}

/** Open a new provider session for the person and answer its first code. */
export function openAccountSession(
  platform: GemieAccountPlatform,
  personAccountId: string,
): Promise<GemieAccountLink> {
  return gateway<GemieAccountLink>(personAccountId, `/accounts/${platform}/sessions/connect`, {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 60_000,
  });
}

/**
 * The account as its session is now: the gateway asked, the row updated when the session moved.
 * The stored row answers when the gateway cannot be asked, so a list never fails on it.
 */
export async function syncAccountSession(
  account: ConnectedAccountRow,
  personAccountId: string,
): Promise<ConnectedAccountRow> {
  if (!account.sessionId || !process.env.INTEGRATIONS_URL) return account;
  let live: GemieAccountSession;
  try {
    live = await gateway<GemieAccountSession>(personAccountId, `${sessionPath(account)}/status`, {
      timeoutMs: 5_000,
    });
  } catch {
    // `gateway` logged what happened; the stored row answers.
    return account;
  }
  const moved =
    live.status !== account.status ||
    (live.phoneNumber && live.phoneNumber !== account.phoneNumber) ||
    (live.displayName && live.displayName !== account.displayName);
  if (!moved) return account;
  return (await setConnectedAccountSessionState(getDb(), account.id, live)) ?? account;
}

/** The session's current code while it waits for its scan, its status synced as it moves. */
export async function readAccountQr(
  account: ConnectedAccountRow,
  personAccountId: string,
): Promise<GemieAccountQr> {
  const qr = await gateway<GemieAccountQr>(personAccountId, `${sessionPath(account)}/qr`);
  if (qr.status !== account.status) await syncAccountSession(account, personAccountId);
  return qr;
}

export function listAccountChats(
  account: ConnectedAccountRow,
  personAccountId: string,
): Promise<GemieAccountChat[]> {
  return gateway<{ chats: GemieAccountChat[] }>(
    personAccountId,
    `${sessionPath(account)}/chats`,
  ).then(({ chats }) => chats);
}

export function readAccountMessages(
  account: ConnectedAccountRow,
  personAccountId: string,
  chatId: string,
  limit: number,
): Promise<GemieAccountMessage[]> {
  return gateway<{ messages: GemieAccountMessage[] }>(
    personAccountId,
    `${sessionPath(account)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`,
  ).then(({ messages }) => messages);
}

export function sendAccountMessage(
  account: ConnectedAccountRow,
  personAccountId: string,
  chatId: string,
  text: string,
): Promise<{ messageId: string }> {
  return gateway<{ messageId: string }>(personAccountId, `${sessionPath(account)}/send`, {
    method: 'POST',
    body: JSON.stringify({ chatId, text }),
  });
}

/**
 * Whether the account's gemie answers a message that arrived on it: never one it was told not to
 * answer, in a group only when the group is allowed and the message mentions or replies to the
 * account, and with `chosen` only in the chats the person picked.
 */
export function shouldAnswer(
  account: Pick<ConnectedAccountRow, 'replies' | 'replyChatIds' | 'groupReplies'>,
  inbound: GemieAccountInbound,
): boolean {
  if (account.replies === 'nobody') return false;
  if (account.replies === 'chosen' && !account.replyChatIds.includes(inbound.chatId)) return false;
  if (inbound.chatKind === 'group') {
    return account.groupReplies === 'mentions' && inbound.mentionsAccount;
  }
  return true;
}

/**
 * Grant the account its durable Oxy task: the linking person's authority, acted on by the gemie.
 * Replaces the task the row held (`account.oxyTaskId`) only if nobody changed it meanwhile.
 */
export async function bindAccountTask(input: {
  account: ConnectedAccountRow;
  gemie: OxyActorGemie;
  personAccountId: string;
  accessToken: string;
}): Promise<void> {
  const { account } = input;
  const taskId = await createOxyTask({
    accessToken: input.accessToken,
    effectiveAccountId: input.personAccountId,
    actor: oxyActorFor(input.gemie, input.personAccountId),
    origin: { kind: 'automation', id: `channel:${account.id}` },
  });
  try {
    if (!(await setConnectedAccountTask(getDb(), account.id, taskId, account.oxyTaskId))) {
      throw new Error('Channel authority changed during renewal');
    }
    account.oxyTaskId = taskId;
    account.oxyTaskState = 'active';
  } catch (error) {
    await revokeOxyTask(taskId);
    throw error;
  }
}

/** Revoke the account's task, if it holds one. */
export async function revokeAccountTask(account: ConnectedAccountRow): Promise<void> {
  if (account.oxyTaskId) await revokeOxyTask(account.oxyTaskId);
  if (!(await setConnectedAccountTask(getDb(), account.id, null, account.oxyTaskId))) {
    throw new Error('Channel authority changed during revocation');
  }
  account.oxyTaskId = null;
  account.oxyTaskState = 'reauth_required';
}

/**
 * Log the account's provider session out and have the gateway forget it, with everything it
 * synced. Best effort: an account is removed here even when the gateway cannot be reached, and a
 * session the gateway still holds then answers nothing, because no row resolves it any more.
 */
export async function endAccountSession(
  account: ConnectedAccountRow,
  personAccountId: string,
): Promise<void> {
  if (!account.sessionId || !process.env.INTEGRATIONS_URL) return;
  try {
    await gateway<null>(personAccountId, sessionPath(account), { method: 'DELETE' });
  } catch {
    // `gateway` logged what happened; the account is removed here regardless.
  }
}

/**
 * Before a gemie is deleted: end every account's session and revoke its task, whoever linked it.
 * The rows themselves go with the gemie (the foreign key cascades). Best effort per account, so one
 * unreachable session does not keep the gemie alive.
 */
export async function releaseGemieAccounts(agentId: string): Promise<void> {
  const accounts = await listAccountsOfGemie(getDb(), agentId);
  await Promise.all(
    accounts.map(async (account) => {
      await endAccountSession(account, account.oxyUserId);
      await revokeAccountTask(account).catch((err: unknown) =>
        log.channels.warn({ err, accountId: account.id }, 'Could not revoke a channel task'),
      );
    }),
  );
}
