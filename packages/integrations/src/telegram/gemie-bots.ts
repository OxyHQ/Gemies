/**
 * Each gemie's own Telegram bot (ADR 0037): its owner pastes a @BotFather token in the gemie's
 * editor, and people talk to the gemie there, alone or in groups.
 *
 * The API keeps the bots and their tokens (encrypted, `bots`) and decides every answer: who pays,
 * which conversation it is, and whether a group message is the gemie's to answer. This module is
 * the Telegram side of it: setting a bot up (profile and webhook), and turning the messages it
 * receives into the API's question and the API's answer into a Telegram message.
 */

import { channelMessageIsEmpty, type GemieTelegramBotSend } from '@gemies/server/internal';
import { Router, type Request, type Response } from 'express';
import { APIClient, type TelegramBotMessage } from '../shared/api-client';
import { answerThroughChat } from '../shared/chat-handler';
import { createLogger } from '../shared/logger';
import { BotApi, TelegramApiError, looksLikeBotToken } from './bot-api';
import { GEMIE_BOT_UPDATES, registerWebhook } from './bots';
import { renderBotPhoto } from './bot-photo';
import { readTelegramMessage } from './inbound';
import { sendReply, sendText, whileTyping } from './send';
import type { TelegramMessage, TelegramUpdate } from './types';
import { webhookUrl } from './webhook';

const logger = createLogger('telegram/gemie-bots');
const apiClient = new APIClient('telegram');

/** A gemie's bot as this process knows it: its client and its @username. */
interface GemieBot {
  api: BotApi;
  username: string;
}

const known = new Map<string, GemieBot>();
let lastRefresh = 0;
/** A bot the cache does not know is asked for again at most this often. */
const REFRESH_ON_MISS_MS = 30_000;

/** Read every gemie's bot from the API, replacing what was known. */
export async function refreshGemieBots(): Promise<GemieBot[]> {
  const bots = await apiClient.listTelegramBots();
  known.clear();
  for (const bot of bots) {
    known.set(bot.botId, { api: new BotApi(bot.token), username: bot.username });
  }
  lastRefresh = Date.now();
  return [...known.values()];
}

/** The gemie bot with this id, asking the API again when it is not known yet. */
export async function findGemieBot(botId: string): Promise<GemieBot | null> {
  const bot = known.get(botId);
  if (bot) return bot;
  if (Date.now() - lastRefresh < REFRESH_ON_MISS_MS) return null;
  await refreshGemieBots();
  return known.get(botId) ?? null;
}

/** Whether a message is addressed to the bot: a mention, a command naming it, or a reply to it. */
export function mentionsBot(message: TelegramMessage, bot: { id: string; username: string }) {
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = `@${bot.username}`.toLowerCase();
  const named = entities.some((entity) => {
    const span = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (entity.type === 'mention') return span === handle;
    if (entity.type === 'text_mention') return String(entity.user?.id) === bot.id;
    if (entity.type === 'bot_command') return span.endsWith(handle);
    return false;
  });
  return named || String(message.reply_to_message?.from?.id) === bot.id;
}

/** The text the gemie reads: without the bot's @handle and without a leading `/command@bot`. */
export function textForGemie(text: string, username: string): string {
  const handle = new RegExp(`@${username}\\b`, 'gi');
  return text
    .replace(/^\/[A-Za-z0-9_]+(@\w+)?\s*/, (command) =>
      /^\/start\b/i.test(command) ? command : '',
    )
    .replace(handle, '')
    .trim();
}

/** Answer one update of a gemie's bot: a message, or an edit of one (stored, not answered). */
export async function handleGemieBotUpdate(bot: GemieBot, update: TelegramUpdate): Promise<void> {
  const edited = update.edited_message !== undefined;
  const message = update.message ?? update.edited_message;
  if (!message?.from || message.from.is_bot) return;
  const chatKind =
    message.chat.type === 'private'
      ? ('direct' as const)
      : message.chat.type === 'group' || message.chat.type === 'supergroup'
        ? ('group' as const)
        : null;
  if (!chatKind) return;
  const addressed = mentionsBot(message, { id: bot.api.botId, username: bot.username });
  // A group message that is not the bot's is never the gemie's to answer, whatever the setting.
  if (chatKind === 'group' && !addressed) return;

  const read = await readTelegramMessage(bot.api, message, {
    text: textForGemie(message.text ?? message.caption ?? '', bot.username),
    download: !edited,
    selfId: bot.api.botId,
  });
  if (channelMessageIsEmpty(read)) return;

  const chatId = String(message.chat.id);
  const question: TelegramBotMessage = {
    chatId,
    chatKind,
    chatTitle: message.chat.title ?? null,
    messageId: String(message.message_id),
    from: {
      id: String(message.from.id),
      username: message.from.username ?? null,
      name: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
      languageCode: message.from.language_code ?? null,
    },
    message: read,
    mentionsBot: addressed,
    ...(edited ? { edited: true } : {}),
  };
  if (edited) {
    await apiClient.answerTelegramBotMessage(bot.api.botId, question);
    return;
  }
  const target = {
    chatId,
    replyToMessageId: chatKind === 'group' ? message.message_id : undefined,
  };
  await whileTyping(bot.api, { chatId }, async () => {
    const answer = await apiClient.answerTelegramBotMessage(bot.api.botId, question);
    if (answer.personTurn) {
      // The bot's person, from the Telegram they linked: their own turn, as in the app (ADR 0037
      // amendment), run as the identity the API verifies again from the bot and the sender.
      await answerThroughChat(
        {
          platform: 'telegram',
          identity: { kind: 'gemie_bot', botId: bot.api.botId, platformUserId: question.from.id },
          conversationId: answer.personTurn.conversationId,
          messageId: answer.personTurn.messageId,
          content: answer.personTurn.content,
          sendResponse: async (reply) => {
            await sendReply(bot.api, target, reply);
          },
          charLimit: 3500,
          platformContext:
            'You are in your own Telegram bot, in a private chat with the person themselves.',
        },
        apiClient,
      ).catch(async (error: unknown) => {
        logger.error(`Bot ${bot.api.botId}: the person's turn failed:`, error);
        await sendText(bot.api, target, 'Sorry, something went wrong. Please try again.');
      });
      return;
    }
    if (answer.reaction) {
      await bot.api
        .setMessageReaction(chatId, message.message_id, answer.reaction)
        .catch((error: unknown) => logger.warn('Could not react to a message:', error));
    }
    if (answer.reply) await sendReply(bot.api, target, answer.reply);
  });
}

/**
 * What a bot shows of the gemie: its name, its description and tagline, and what its photo is
 * drawn from (`null` leaves the photo as it is: the API sends it only when the look or the colour
 * changed).
 */
interface BotProfile {
  name: string;
  description: string;
  shortDescription: string;
  photo: { character: unknown; color: string | null } | null;
}

/** Fit a string within Telegram's limit for the field. */
const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

/**
 * Give the bot the gemie's profile. A part already as wanted is not set again, because Telegram
 * rate-limits profile updates; each part is tried on its own, so a refused picture still leaves the
 * name and description set. A rate limit stops the rest and says when to come back.
 */
async function applyProfile(api: BotApi, profile: BotProfile) {
  const result = { name: false, description: false, photo: false };
  let retryAfter: number | undefined;
  let error: string | undefined;
  const attempt = async (part: keyof typeof result, run: () => Promise<unknown>) => {
    if (retryAfter !== undefined) return;
    try {
      await run();
      result[part] = true;
    } catch (failure: unknown) {
      logger.warn(`Bot ${api.botId}: setting its ${part} failed:`, failure);
      if (failure instanceof TelegramApiError) {
        error = failure.description;
        if (failure.retryAfter !== undefined) retryAfter = failure.retryAfter;
      } else {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
  };
  const name = clip(profile.name, 64);
  const description = clip(profile.description, 512);
  const shortDescription = clip(profile.shortDescription, 120);
  await attempt('name', async () => {
    const current = await api.call<{ name: string }>('getMyName');
    if (current.name !== name) await api.call('setMyName', { name });
  });
  await attempt('description', async () => {
    const current = await api.call<{ description: string }>('getMyDescription');
    if (current.description !== description) await api.call('setMyDescription', { description });
    const short = await api.call<{ short_description: string }>('getMyShortDescription');
    if (short.short_description !== shortDescription) {
      await api.call('setMyShortDescription', { short_description: shortDescription });
    }
  });
  const photo = profile.photo;
  if (photo) {
    await attempt('photo', async () => {
      const bytes = await renderBotPhoto(photo.character, photo.color);
      await api.upload(
        'setMyProfilePhoto',
        { photo: { type: 'static', photo: 'attach://avatar' } },
        [{ field: 'avatar', filename: 'avatar.jpg', contentType: 'image/jpeg', bytes }],
      );
    });
  }
  return {
    profile: result,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(error ? { error } : {}),
  };
}

/** The token a management call names, or an answer already sent. */
function tokenOf(req: Request, res: Response): BotApi | null {
  const token = (req.body as { token?: unknown })?.token;
  if (typeof token !== 'string' || !looksLikeBotToken(token.trim())) {
    res.status(400).json({ error: 'A @BotFather token is required', code: 'invalid_token' });
    return null;
  }
  return new BotApi(token.trim());
}

/** A Telegram refusal as the API reads it: the token is wrong, or Telegram said something else. */
function answerTelegramError(res: Response, error: unknown, what: string) {
  if (error instanceof TelegramApiError && (error.code === 401 || error.code === 404)) {
    res.status(400).json({ error: 'Telegram does not accept this token', code: 'invalid_token' });
    return;
  }
  logger.error(`${what} failed:`, error);
  res.status(502).json({
    error: error instanceof TelegramApiError ? error.description : 'Telegram could not be reached',
    code: 'telegram_unavailable',
  });
}

/**
 * The API's routes for a gemie's bot, mounted at `/telegram/bots` behind the API workload check.
 * The token travels in the body of each call (never in a URL), because the API keeps it.
 */
export function gemieBotsRouter(): Router {
  const router = Router();

  // Check the token and point the bot's webhook here. Its profile follows (`/profile`).
  router.post('/setup', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    try {
      const me = await api.getMe();
      if (!me.username) {
        return res.status(400).json({ error: 'This bot has no username', code: 'invalid_token' });
      }
      await registerWebhook(api, GEMIE_BOT_UPDATES);
      known.set(api.botId, { api, username: me.username });
      res.json({
        botId: api.botId,
        username: me.username,
        name: me.first_name,
        canJoinGroups: me.can_join_groups ?? false,
        canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
      });
    } catch (error: unknown) {
      answerTelegramError(res, error, 'Setting a gemie bot up');
    }
  });

  // Give the bot the gemie's profile (the gemie changed). What Telegram took, part by part.
  router.post('/profile', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    try {
      await api.getMe();
      res.json(await applyProfile(api, req.body.profile as BotProfile));
    } catch (error: unknown) {
      answerTelegramError(res, error, 'Updating a gemie bot profile');
    }
  });

  // How the bot is now, as Telegram sees it: for the editor's live status.
  router.post('/status', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    try {
      const [me, info] = await Promise.all([api.getMe(), api.getWebhookInfo()]);
      const recentError =
        info.last_error_date && info.last_error_date * 1000 > Date.now() - 60 * 60_000
          ? (info.last_error_message ?? 'Telegram could not deliver')
          : null;
      res.json({
        username: me.username ?? null,
        name: me.first_name,
        canJoinGroups: me.can_join_groups ?? false,
        canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
        webhook: info.url === webhookUrl(api.botId) ? (recentError ? 'failing' : 'ok') : 'missing',
        webhookError: recentError,
        pendingUpdates: info.pending_update_count,
      });
    } catch (error: unknown) {
      answerTelegramError(res, error, 'Reading a gemie bot');
    }
  });

  // The gemie writes first in one of its chats: a scheduled result, a follow-up (ADR 0037 amendment).
  router.post('/send', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    const { chatId, text } = req.body as Partial<GemieTelegramBotSend>;
    if (
      typeof chatId !== 'string' ||
      !/^-?\d{1,20}$/.test(chatId) ||
      typeof text !== 'string' ||
      !text.trim()
    ) {
      return res.status(400).json({ error: 'A chat and a text are required' });
    }
    try {
      await sendReply(api, { chatId }, text);
      res.status(204).end();
    } catch (error: unknown) {
      answerTelegramError(res, error, 'Writing in a gemie bot chat');
    }
  });

  // Stop the bot's webhook: its gemie no longer answers there. A revoked token is already done.
  router.post('/teardown', async (req, res) => {
    const api = tokenOf(req, res);
    if (!api) return;
    known.delete(api.botId);
    try {
      await api.deleteWebhook();
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError && (error.code === 401 || error.code === 404))) {
        logger.warn(`Bot ${api.botId}: removing its webhook failed:`, error);
      }
    }
    res.status(204).end();
  });

  return router;
}
