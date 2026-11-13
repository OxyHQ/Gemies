import { createHash } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import {
  listAccountsGrantedTo,
  type ConnectedAccountRow,
} from '../../db/integrations/connectedAccountRepository.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { notifyAccountPerson } from '../connected-accounts.js';
import { getRedisClient } from '../redis.js';

/** How long a run's sent messages are remembered: past any retry of that run. */
const SENT_MARK_TTL_SECONDS = 24 * 60 * 60;

/**
 * Claim the right to send `message` for this run, once. A run the queue retries after a failure part-way
 * would otherwise send everything it already sent: a Telegram message cannot be taken back. `SET NX` is
 * atomic across instances. True: send it. False: this run already sent exactly this text.
 *
 * The caller releases the claim when the send does not succeed, so the retry the claim exists for can
 * actually send it. Without Redis (development) there is nothing to claim against and the send
 * proceeds; with Redis down the claim fails open, because a missed alert is worse than a repeated one.
 */
async function claimSend(
  runId: string,
  userId: string,
  message: string,
): Promise<{ claimed: false } | { claimed: true; release: () => Promise<void> }> {
  const redis = getRedisClient();
  const nothingToRelease = { claimed: true as const, release: async () => undefined };
  if (!redis) return nothingToRelease;
  const digest = createHash('sha256').update(message).digest('hex').slice(0, 32);
  const key = `alia:tg-sent:${runId}:${userId}:${digest}`;
  try {
    const set = await redis.set(key, '1', 'EX', SENT_MARK_TTL_SECONDS, 'NX');
    if (set !== 'OK') return { claimed: false };
    return {
      claimed: true,
      release: async () => {
        await redis.del(key).catch(() => undefined);
      },
    };
  } catch (error: unknown) {
    log.tools.warn({ err: error, runId }, 'Could not claim a Telegram send; sending anyway');
    return nothingToRelease;
  }
}

/** Whose turn, with which gemie. */
interface TelegramScope {
  readonly agentId: string;
  readonly oxyUserId: string;
}

/**
 * The person's Telegram that they granted this gemie (ADR 0035 as amended, 0037): the account whose
 * own chat with the shared Gemies bot a notification is written in. One turned off in Telegram
 * (`paused`) still reaches the person there; one unlinked or never finished does not.
 */
async function telegramAccountOf(scope: TelegramScope): Promise<ConnectedAccountRow | null> {
  const accounts = await listAccountsGrantedTo(getDb(), scope, ['connected', 'paused']);
  return accounts.find((account) => account.platform === 'telegram' && account.sessionId) ?? null;
}

/**
 * `sendTelegramMessage`: write to the person on Telegram — a notification, in their own chat with
 * the shared Gemies bot. Offered only when the person granted this gemie their Telegram, and it
 * works with nobody present (a task, a watch, an event), since the link never expires here.
 */
export async function buildSendTelegramTool(
  scope: TelegramScope,
  runId?: string,
): Promise<ToolSet> {
  if (!process.env.INTEGRATIONS_URL) return {};
  let account: ConnectedAccountRow | null;
  try {
    account = await telegramAccountOf(scope);
  } catch (error: unknown) {
    log.tools.warn({ err: error }, 'Could not read the Telegram account of a turn');
    return {};
  }
  if (!account) return {};
  const linked = account;

  async function sendOnce(message: string): Promise<{ success: boolean; message: string }> {
    try {
      await notifyAccountPerson(linked, scope.oxyUserId, message);
      log.tools.info({ accountId: linked.id }, 'Telegram notification sent');
      return { success: true, message: 'Telegram message sent successfully' };
    } catch (error: unknown) {
      log.tools.error({ err: error, accountId: linked.id }, 'Telegram notification failed');
      return {
        success: false,
        message: `Could not send it on Telegram: ${getErrorMessage(error)}`,
      };
    }
  }

  return {
    sendTelegramMessage: tool({
      description:
        'Send the person a message on their own Telegram (from the Gemies bot). Only when they asked for it, now or in a task or watch they set up.',
      inputSchema: z.object({
        message: z.string().describe('The complete message'),
      }),
      execute: async ({ message }) => {
        // A run that is retried does not send again what it already sent.
        if (runId === undefined) return sendOnce(message);
        const claim = await claimSend(runId, scope.oxyUserId, message);
        if (!claim.claimed) {
          return { success: true, message: 'Telegram message already sent in this run' };
        }
        const result = await sendOnce(message);
        if (!result.success) await claim.release();
        return result;
      },
    }),
  };
}
