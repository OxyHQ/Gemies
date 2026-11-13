/**
 * Setting up, refreshing and stopping a gemie's own Telegram bot (ADR 0037), through the
 * integrations process, which is the only one that speaks Telegram's Bot API. The token travels in
 * the body of each internal call, because this service keeps it (`bots.bot_token`, encrypted).
 */

import { getDb } from '../db/index.js';
import {
  deleteGemieBot,
  findActiveGemieBotTokenByTelegramId,
  findGemieBotToken,
} from '../db/integrations/gemieBotRepository.js';
import { botChatOf } from '../domain/gemie-bot-person.js';
import { integrationsServiceFetch } from './integrations-client.js';
import { log } from './logger.js';
import { revokeReleasedTask } from './oxy-task-authority.js';

/** A setup call that did not succeed: the token is wrong, or Telegram or the service failed. */
export class TelegramBotSetupError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'invalid_token' | 'telegram_unavailable' | 'integrations_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * What the bot shows of the gemie. `photo` is what its picture is drawn from (the integrations
 * process draws it, with Bloom's `renderAgentAvatarPicture`); `null` leaves the photo as it is.
 */
export interface TelegramBotProfile {
  name: string;
  description: string;
  shortDescription: string;
  photo: { character: unknown; color: string | null } | null;
}

/** What Telegram took, part by part, and when it asked to be left alone for a while. */
export interface TelegramBotProfileResult {
  profile: { name: boolean; description: boolean; photo: boolean };
  /** Seconds, from Telegram's `retry_after`, when it rate-limited the update. */
  retryAfter?: number;
  /** What Telegram said, when a part failed. */
  error?: string;
}

export interface TelegramBotSetup {
  botId: string;
  username: string;
  name: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
}

export interface TelegramBotLiveStatus {
  username: string | null;
  name: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
  webhook: 'ok' | 'failing' | 'missing';
  webhookError: string | null;
  pendingUpdates: number;
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await integrationsServiceFetch(`/telegram/bots${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error: unknown) {
    log.channels.warn({ err: error, path }, 'The integrations service could not be reached');
    throw new TelegramBotSetupError(
      503,
      'integrations_unavailable',
      'The messaging service could not be reached',
    );
  }
  const answer = (response.status === 204 ? null : await response.json().catch(() => null)) as
    | (T & { error?: string; code?: string })
    | null;
  if (!response.ok) {
    const invalid = answer?.code === 'invalid_token';
    throw new TelegramBotSetupError(
      invalid ? 400 : 503,
      invalid ? 'invalid_token' : 'telegram_unavailable',
      answer?.error ?? `The messaging service answered ${response.status}`,
    );
  }
  return answer as T;
}

/** Check the token and point the bot's webhook here. Its profile follows (`gemie-telegram-bot-profile.ts`). */
export function setUpTelegramBot(token: string) {
  return call<TelegramBotSetup>('/setup', { token });
}

export function updateTelegramBotProfile(token: string, profile: TelegramBotProfile) {
  return call<TelegramBotProfileResult>('/profile', { token, profile });
}

export function readTelegramBotStatus(token: string) {
  return call<TelegramBotLiveStatus>('/status', { token });
}

/** Stop a bot's webhook. Best effort: the bot is forgotten here whether or not Telegram answers. */
export async function tearDownTelegramBot(token: string): Promise<void> {
  try {
    await call<null>('/teardown', { token });
  } catch (error: unknown) {
    log.channels.warn({ err: error }, 'A Telegram bot webhook could not be removed');
  }
}

/**
 * A message the gemie posted on its own into one of its bot's conversations (a scheduled result, a
 * follow-up, a check-in) reaches that Telegram chat too: the chat IS the conversation (ADR 0037,
 * amendment). Only the bot of the gemie that wrote it; nothing for any other conversation.
 */
export async function relayToGemieBotChat(input: {
  agentId: string;
  conversationId: string;
  text: string;
}): Promise<void> {
  const chat = botChatOf(input.conversationId);
  if (!chat) return;
  const bot = await findActiveGemieBotTokenByTelegramId(getDb(), chat.botId);
  if (!bot || bot.agentId !== input.agentId) return;
  await call<null>('/send', { token: bot.token, chatId: chat.chatId, text: input.text });
}

/**
 * Before a gemie is deleted, or when its bot is removed: stop its bot and forget it, with the
 * authority its person's link held.
 */
export async function releaseGemieTelegramBot(agentId: string): Promise<void> {
  const db = getDb();
  const token = await findGemieBotToken(db, agentId);
  if (token) await tearDownTelegramBot(token);
  await revokeReleasedTask(await deleteGemieBot(db, agentId));
}
