import express from 'express';
import crypto from 'node:crypto';
import { verifySecret } from '@oxy.so/core/server';
import { getChannel } from '../lib/channels/registry.js';
import { getDb } from '../db/index.js';
import { findSystemBot, upsertBotUser, type BotRow } from '../db/integrations/botRepository.js';
import { integrationsServiceFetch } from '../lib/integrations-client.js';
import type { ChannelId, ChannelInboundMessage } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';
import { processChannelMessage } from '../lib/channels/inbound-handlers.js';
import { processAcceptedChannelInbound } from '../lib/channels/inbound-sweep.js';
import { acceptChannelInbound } from '../db/integrations/channelInboundRepository.js';

export { processChannelMessage };

/**
 * The dedup key of an inbound message: `${channelType}:${platformUserId}:${hash(text)}`.
 *
 * Stored in `channel_inbound` (`acceptChannelInbound`), so a platform retry is
 * recognised on ANY instance and across a restart, within the 60-second window.
 */
export function getDeduplicationKey(
  channelType: ChannelId,
  message: ChannelInboundMessage,
): string {
  const contentHash = crypto.createHash('md5').update(message.text).digest('hex').slice(0, 12);
  return `${channelType}:${message.platformUserId}:${contentHash}`;
}

const router = express.Router();

/**
 * POST /webhooks/telegram/:botId — where Telegram delivers every update of our bots: the shared
 * Gemies bot and each gemie's own (ADR 0037).
 *
 * The integrations process speaks Telegram and is private (oxy-infra `app-alia-integrations.tf`),
 * so this public API is its ingress: the delivery is relayed there as it came, body and Telegram's
 * secret header, as the API workload. That process checks the secret (derived per bot, never
 * stored), stores the update and answers; its answer is Telegram's, so a failure to store makes
 * Telegram deliver it again.
 */
router.post('/telegram/:botId', async (req: express.Request<{ botId: string }>, res) => {
  const { botId } = req.params;
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!/^\d{5,20}$/.test(botId) || typeof secret !== 'string' || secret.length === 0) {
    return res.sendStatus(401);
  }
  try {
    const relayed = await integrationsServiceFetch(`/telegram/updates/${botId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(15_000),
    });
    res.sendStatus(relayed.status === 401 || relayed.ok ? relayed.status : 503);
  } catch (error: unknown) {
    log.webhook.error({ err: error, botId }, 'Could not relay a Telegram update');
    res.sendStatus(503);
  }
});

// WhatsApp GET verification (hub.challenge)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && verifyToken && verifySecret(token, verifyToken)) {
    log.webhook.info('WhatsApp verification successful');
    res.status(200).send(challenge);
  } else {
    log.webhook.warn('WhatsApp verification failed');
    res.sendStatus(403);
  }
});

// Unified webhook handler for all channels
router.post('/:type', async (req, res) => {
  const channelType = req.params.type as ChannelId;

  const channel = getChannel(channelType);
  if (!channel) {
    log.webhook.warn({ channelType }, 'Unknown channel type');
    return res.sendStatus(404);
  }

  if (!channel.webhook) {
    log.webhook.warn({ channelType }, 'Channel has no webhook adapter');
    return res.sendStatus(404);
  }

  // Slack URL verification challenge
  if (channelType === 'slack' && req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify webhook signature
  if (!channel.webhook.verifySignature(req)) {
    log.webhook.warn({ channelType }, 'Signature verification failed');
    return res.sendStatus(401);
  }

  // Discord interaction ping
  if (channelType === 'discord' && req.body?.type === 1) {
    return res.json({ type: 1 });
  }

  // Parse the inbound message
  const message = channel.webhook.parseMessage(req.body);
  if (!message) {
    return res.sendStatus(200);
  }

  // The message TEXT is a user prompt and never goes to the log; its length is
  // what an operator actually needs to tell an empty webhook from a real one.
  // `username` is out for the same reason `text` is — the platform user id is
  // the opaque handle every other line in this file correlates on.
  log.webhook.info(
    {
      channelType,
      from: message.platformUserId,
      chatId: message.chatId,
      textLength: message.text.length,
    },
    'Inbound message',
  );

  try {
    // Find the system bot for this channel type. Scoped to `userId: { $exists: false }`
    // so a legitimate global-bot update never binds to a user-registered bot now that
    // both live in the same collection — this selects the exact same (system) document
    // the query returned before per-bot support existed.
    const bot: BotRow | null = await findSystemBot(getDb(), channelType, { activeOnly: true });
    if (!bot) {
      log.webhook.warn({ channelType }, 'No active bot found for channel type');
      return res.sendStatus(200);
    }

    // Find or create bot user, in one statement.
    const botUser = await upsertBotUser(getDb(), {
      botId: bot.id,
      platform: channelType,
      platformUserId: message.platformUserId,
      chatId: message.chatId,
      username: message.username,
      displayName: message.displayName,
    });

    // Durable, and BEFORE the ack (see the per-bot path above).
    const inboundId = await acceptChannelInbound(getDb(), {
      dedupeKey: getDeduplicationKey(channelType, message),
      kind: 'system',
      channelType,
      botId: bot.id,
      botUserId: botUser.id,
      message,
    });
    if (!inboundId) {
      log.webhook.info(
        { channelType, platformUserId: message.platformUserId },
        'Duplicate message skipped',
      );
      return res.sendStatus(200);
    }

    // Respond immediately to webhook (Slack has 3s timeout)
    res.sendStatus(200);

    processAcceptedChannelInbound(inboundId).catch((error: unknown) => {
      log.webhook.error({ err: error, channelType }, 'Async processing error');
    });
  } catch (error: unknown) {
    // Nothing was stored, so let the platform retry rather than lose the message.
    log.webhook.error({ err: error, channelType }, 'Error processing webhook message');
    if (!res.headersSent) res.sendStatus(500);
  }
});

export default router;
