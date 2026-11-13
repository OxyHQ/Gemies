/**
 * Telegram, on its official Bot API only (ADR 0037). One layer for both ways a gemie is on
 * Telegram:
 *
 *  - a person's own account, through Telegram Business and the shared Gemies bot: a connected
 *    account like WhatsApp (`./business/`, mounted by `index.ts` as the `telegram` gateway);
 *  - a gemie's own bot, whose token its owner pasted (`./gemie-bots.ts`).
 *
 * Both are delivered to one webhook (`./webhook.ts`), kept in one inbox until handled
 * (`./inbox.ts`), routed here by the bot they arrived on, and answered through one client
 * (`./bot-api.ts`) and one sender (`./send.ts`).
 */

import type { Router } from 'express';
import { createLogger } from '../shared/logger';
import {
  GEMIE_BOT_UPDATES,
  keepWebhooks,
  SHARED_BOT_UPDATES,
  sharedBot,
  sharedBotUsername,
} from './bots';
import { handleSharedBotUpdate } from './business/handle';
import {
  findGemieBot,
  gemieBotsRouter,
  handleGemieBotUpdate,
  refreshGemieBots,
} from './gemie-bots';
import { startSweeping } from './inbox';
import type { TelegramUpdate } from './types';
import { updatesRouter } from './webhook';

const logger = createLogger('telegram');

/** Route an update to the bot it arrived on. */
async function handleUpdate(botId: string, update: TelegramUpdate): Promise<void> {
  const shared = sharedBot();
  if (shared && botId === shared.botId) {
    await handleSharedBotUpdate(shared, await sharedBotUsername(), update);
    return;
  }
  const gemieBot = await findGemieBot(botId);
  if (gemieBot) {
    await handleGemieBotUpdate(gemieBot, update);
    return;
  }
  logger.warn(`An update arrived for bot ${botId}, which is no longer ours; dropped`);
}

async function isOurBot(botId: string): Promise<boolean> {
  return sharedBot()?.botId === botId || (await findGemieBot(botId)) !== null;
}

/** The routes the API calls: its webhook relay, and the management of gemies' bots. */
export function telegramRoutes(): { updates: Router; bots: Router } {
  return { updates: updatesRouter({ isOurBot, handle: handleUpdate }), bots: gemieBotsRouter() };
}

let stops: Array<() => void> = [];

/**
 * Start Telegram once the server listens: finish what a previous process left in the inbox, and
 * register then keep healing every bot's webhook.
 */
export async function startTelegram(): Promise<void> {
  stops = [
    startSweeping(handleUpdate),
    keepWebhooks(async () => {
      const shared = sharedBot();
      // The API may still be rolling out: the shared bot is kept either way.
      const gemieBots = await refreshGemieBots().catch((error: unknown) => {
        logger.error('Could not read the gemies’ bots from the API:', error);
        return [];
      });
      return [
        ...(shared ? [{ api: shared, updates: SHARED_BOT_UPDATES }] : []),
        ...gemieBots.map((bot) => ({ api: bot.api, updates: GEMIE_BOT_UPDATES })),
      ];
    }),
  ];
}

export async function stopTelegram(): Promise<void> {
  for (const stop of stops) stop();
  stops = [];
}
