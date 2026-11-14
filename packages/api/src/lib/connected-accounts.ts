/**
 * A person's connected accounts: the provider sessions behind them and who answers them (ADR 0035
 * as amended).
 *
 * A person connects a WhatsApp account, or Telegram through Telegram Business (ADR 0037), once, and
 * grants it to the gemies that may use it. The integrations gateway holds the provider session and
 * speaks one contract for every platform (`@gemies/server/internal`); this service holds the row and
 * its grants. At most one granted gemie ANSWERS what arrives on it, when the account's replies say
 * so (`shouldAnswer`), acting for the person on Gemies' own first-party authority (oxy ADR 0066):
 * choosing no gemie, or disconnecting the account, is the off switch. Every granted gemie can read and send through it when the person
 * asks or its tasks need it (`tools/accounts.ts`).
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
  setAnsweringGemie,
  setConnectedAccountSessionState,
  type ConnectedAccountRow,
} from '../db/integrations/connectedAccountRepository.js';
import { integrationsFetch } from './integrations-client.js';
import { log } from './logger.js';

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

/** The platform a client named, or `null` when it is not one an account can be connected on. */
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
    (live.displayName && live.displayName !== account.displayName) ||
    (typeof live.canReply === 'boolean' && live.canReply !== account.canReply);
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
 * Write to the person whose account it is — a notification, not a message to a contact. Telegram
 * writes in the person's own chat with the shared Gemies bot; a platform with no way to reach them
 * answers a `GatewayError`.
 */
export function notifyAccountPerson(
  account: ConnectedAccountRow,
  personAccountId: string,
  text: string,
): Promise<{ messageId: string }> {
  return gateway<{ messageId: string }>(personAccountId, `${sessionPath(account)}/notify`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

/**
 * Whether the account's answering gemie answers a message that arrived on it, by the account's
 * replies (the caller has already found that one answers): never one it was told not to answer, in a group only when the group is allowed and the message mentions or replies to the
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

/** Choose the gemie that answers the account, or none (`null`). */
export async function setAccountAnswering(input: {
  account: ConnectedAccountRow;
  gemie: { readonly _id: string } | null;
}): Promise<void> {
  await setAnsweringGemie(getDb(), input.account.id, input.gemie?._id ?? null);
}
