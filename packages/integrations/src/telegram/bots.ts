/**
 * The Telegram bots this service speaks for, and their webhooks kept pointing here.
 *
 *  - The SHARED Gemies bot, `TELEGRAM_BOT_TOKEN`: people connect it to their own account in
 *    Telegram › Settings › Telegram Business › Chatbots (`./business/`).
 *  - Each gemie's OWN bot, whose token its owner pasted in the gemie's editor. The API keeps those
 *    tokens (encrypted, in `bots`), so this list is the API's, read at startup and every few
 *    minutes (`./gemie-bots.ts`).
 *
 * A webhook heals itself: every bot's is registered at startup (a deploy re-registers them all),
 * and checked with `getWebhookInfo` every ten minutes, so one that Telegram dropped, or that
 * points at an old address, is set again with nobody doing anything.
 */

import { createLogger } from '../shared/logger';
import { BotApi, TelegramApiError } from './bot-api';
import { webhookSecret, webhookUrl } from './webhook';

const logger = createLogger('telegram/bots');

const HEAL_INTERVAL_MS = 10 * 60_000;

/** What the shared bot is sent: its own chats (linking) and everything Telegram Business sends. */
export const SHARED_BOT_UPDATES = [
  'message',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;

/** What a gemie's own bot is sent: the messages people write to it, alone or in groups. */
export const GEMIE_BOT_UPDATES = ['message'] as const;

let shared: BotApi | null | undefined;

/** The shared bot, or `null` when this deployment has none (`TELEGRAM_BOT_TOKEN` unset). */
export function sharedBot(): BotApi | null {
  if (shared === undefined) {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    shared = token ? new BotApi(token) : null;
  }
  return shared;
}

let sharedUsername: string | null = null;

/** The shared bot's @username, asked of Telegram once. */
export async function sharedBotUsername(): Promise<string> {
  const bot = sharedBot();
  if (!bot) throw new Error('The shared Telegram bot is not configured');
  if (!sharedUsername) {
    const me = await bot.getMe();
    if (!me.username) throw new Error('The shared Telegram bot has no username');
    sharedUsername = me.username;
  }
  return sharedUsername;
}

function sameUpdates(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const have = new Set(a ?? []);
  return have.size === b.length && b.every((update) => have.has(update));
}

/** Point a bot's webhook here, with its secret and the updates it is sent. */
export async function registerWebhook(api: BotApi, updates: readonly string[]): Promise<void> {
  await api.setWebhook({
    url: webhookUrl(api.botId),
    secretToken: webhookSecret(api.botId),
    allowedUpdates: updates,
  });
}

/**
 * Set the webhook again when Telegram holds a different one (an old address, other updates, or
 * none). A webhook that is right but failing is left as is and said in the log: Telegram keeps
 * retrying it, and re-registering would change nothing.
 */
export async function healWebhook(api: BotApi, updates: readonly string[]): Promise<void> {
  const info = await api.getWebhookInfo();
  if (info.url !== webhookUrl(api.botId) || !sameUpdates(info.allowed_updates, updates)) {
    logger.warn(`Webhook of bot ${api.botId} was not ours; registering it again`);
    await registerWebhook(api, updates);
    return;
  }
  if (info.last_error_date && info.last_error_date * 1000 > Date.now() - HEAL_INTERVAL_MS) {
    logger.warn(
      `Telegram could not deliver to bot ${api.botId} (${info.pending_update_count} pending): ${info.last_error_message ?? 'no reason given'}`,
    );
  }
}

/**
 * Register now, then heal every ten minutes, each bot that `listBots` names, until the returned
 * stop is called. One bot failing (a revoked token) never stops the others.
 */
export function keepWebhooks(
  listBots: () => Promise<Array<{ api: BotApi; updates: readonly string[] }>>,
): () => void {
  const each = async (first: boolean) => {
    let bots: Array<{ api: BotApi; updates: readonly string[] }>;
    try {
      bots = await listBots();
    } catch (error: unknown) {
      logger.error('Could not list the Telegram bots:', error);
      return;
    }
    for (const { api, updates } of bots) {
      try {
        if (first) await registerWebhook(api, updates);
        else await healWebhook(api, updates);
      } catch (error: unknown) {
        const why = error instanceof TelegramApiError ? error.message : String(error);
        logger.error(`Webhook of bot ${api.botId} could not be kept: ${why}`);
      }
    }
  };
  void each(true);
  const timer = setInterval(() => void each(false), HEAL_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
