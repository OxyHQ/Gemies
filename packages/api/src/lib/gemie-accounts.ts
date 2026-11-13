/**
 * A gemie's connected accounts: the provider sessions behind them and the Oxy authority they carry
 * (ADR 0035).
 *
 * A person links a WhatsApp or Telegram account to ONE gemie. The integrations service holds the
 * provider session; this service holds the row, and with it a durable Oxy task the person granted
 * when linking it, whose actor is the gemie's own (`oxyActorFor`): Alia's lane is the person's own,
 * every other gemie acts as its account. What arrives on the account is answered by that gemie
 * (`middleware/channel-auth.ts`), and only that gemie's turns can use it (`tools/whatsapp.ts`).
 */

import { getDb } from '../db/index.js';
import {
  listAccountsOfGemie,
  setConnectedAccountTask,
  type ConnectedAccountRow,
} from '../db/integrations/connectedAccountRepository.js';
import type { ConnectedAccountPlatform } from '../db/schema/integrations.js';
import { CONNECTED_ACCOUNT_PLATFORMS } from '../db/schema/integrations.js';
import { oxyActorFor, type OxyActorGemie } from './gemie-oxy-actor.js';
import { integrationsFetch } from './integrations-client.js';
import { log } from './logger.js';
import { createOxyTask, revokeOxyTask } from './oxy-task-authority.js';

/**
 * Platform -> the integrations service's adapter path. A `Map`, so a platform read from a URL can
 * never resolve to an inherited property (`'constructor'`) the way an object literal's would.
 */
const ADAPTER_PATHS = new Map<ConnectedAccountPlatform, string>([
  ['whatsapp', 'accounts/whatsapp'],
  ['telegram', 'accounts/telegram-gateway'],
]);

/** The platform a client named, or `null` when it is not one a gemie can be linked to. */
export function connectedAccountPlatformOf(value: string): ConnectedAccountPlatform | null {
  return CONNECTED_ACCOUNT_PLATFORMS.find((platform) => platform === value) ?? null;
}

/** The integrations path of one session of `platform`. */
export function sessionPath(platform: ConnectedAccountPlatform, sessionId: string): string {
  return `/${ADAPTER_PATHS.get(platform)}/sessions/${encodeURIComponent(sessionId)}`;
}

/** Where a new session of `platform` is opened. */
export function connectPath(platform: ConnectedAccountPlatform): string {
  return `/${ADAPTER_PATHS.get(platform)}/sessions/connect`;
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

/** Ask the integrations service to end the account's provider session. Best effort. */
export async function endAccountSession(
  account: ConnectedAccountRow,
  personAccountId: string,
): Promise<void> {
  if (!account.sessionId) return;
  try {
    await integrationsFetch(
      personAccountId,
      `${sessionPath(account.platform, account.sessionId)}/disconnect`,
      { method: 'POST', signal: AbortSignal.timeout(10_000) },
    );
  } catch (err: unknown) {
    log.channels.warn({ err, accountId: account.id }, 'Could not end a connected account session');
  }
}

/**
 * Before a gemie is deleted: end every account's session and revoke its task, whoever linked it.
 * The rows themselves go with the gemie (the foreign key cascades). Best effort per account, so one
 * unreachable session does not keep the gemie alive; a session the integrations service still holds
 * afterwards answers nothing, because no row resolves it any more.
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
