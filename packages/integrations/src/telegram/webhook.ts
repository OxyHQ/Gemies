/**
 * Where Telegram delivers our bots' updates, and how a delivery is known to be Telegram's.
 *
 * Every bot's webhook is `${API_BASE_URL}/webhooks/telegram/<botId>`: the public API is this
 * service's only ingress (it stays private, see oxy-infra `app-alia-integrations.tf`), and it
 * relays the request here as the API workload, header and body untouched. The proof of origin is
 * Telegram's: `setWebhook`'s `secret_token`, echoed in `X-Telegram-Bot-Api-Secret-Token` on every
 * delivery. Each bot's secret is derived from its id and `TOKEN_ENCRYPTION_KEY`, so it is never
 * stored, survives every restart and is the same on every task, and one bot's secret says nothing
 * about another's.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { createLogger } from '../shared/logger';
import { acceptUpdate, processUpdate, type UpdateHandler } from './inbox';
import type { TelegramUpdate } from './types';

const logger = createLogger('telegram/webhook');

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** The `secret_token` a bot's webhook is registered with: 64 hex characters, allowed by Telegram. */
export function webhookSecret(botId: string): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is required to sign Telegram webhooks');
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`telegram-webhook:${botId}`)
    .digest('hex');
}

/** The URL a bot's webhook points at. */
export function webhookUrl(botId: string): string {
  const base = (process.env.API_BASE_URL || 'http://localhost:4150').replace(/\/+$/, '');
  return `${base}/webhooks/telegram/${botId}`;
}

function isTelegramDelivery(botId: string, header: unknown): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const expected = Buffer.from(webhookSecret(botId));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * `POST /telegram/updates/:botId`, mounted behind the API workload check: store the update, answer
 * 200 so Telegram moves on, then handle it. A storage failure answers 500 so Telegram retries.
 */
export function updatesRouter(input: {
  isOurBot: (botId: string) => Promise<boolean>;
  handle: UpdateHandler;
}): Router {
  const router = Router();
  router.post('/:botId', async (req: Request<{ botId: string }>, res: Response) => {
    const { botId } = req.params;
    if (
      !/^\d{5,20}$/.test(botId) ||
      !isTelegramDelivery(botId, req.headers[TELEGRAM_SECRET_HEADER])
    ) {
      res.status(401).json({ error: 'Not a Telegram delivery' });
      return;
    }
    const update = req.body as TelegramUpdate;
    if (typeof update?.update_id !== 'number') {
      res.status(400).json({ error: 'Not a Telegram update' });
      return;
    }
    try {
      // A bot that is no longer ours (its gemie removed it) is acknowledged and dropped, so
      // Telegram stops retrying a delivery nobody will answer.
      if (!(await input.isOurBot(botId))) {
        res.status(200).json({ ok: true });
        return;
      }
      const fresh = await acceptUpdate(botId, update);
      res.status(200).json({ ok: true });
      if (fresh) {
        void processUpdate(botId, update.update_id, input.handle).catch((error: unknown) =>
          logger.error(`Handling update ${update.update_id} of bot ${botId} failed:`, error),
        );
      }
    } catch (error: unknown) {
      logger.error(`Could not accept update ${update.update_id} of bot ${botId}:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'Could not accept the update' });
    }
  });
  return router;
}
