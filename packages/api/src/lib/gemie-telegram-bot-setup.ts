/**
 * Setting up, refreshing and stopping a gemie's own Telegram bot (ADR 0037), through the
 * integrations process, which is the only one that speaks Telegram's Bot API. The token travels in
 * the body of each internal call, because this service keeps it (`bots.bot_token`, encrypted).
 */

import type { AgentRecord } from '../db/agents/agentRepository.js';
import { getDb } from '../db/index.js';
import { deleteGemieBot, findGemieBotToken } from '../db/integrations/gemieBotRepository.js';
import { agentPromptName, attachAgentIdentity } from './agent-identity.js';
import { integrationsServiceFetch } from './integrations-client.js';
import { log } from './logger.js';

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

/** What the bot shows of the gemie. */
export interface TelegramBotProfile {
  name: string;
  description: string;
  shortDescription: string;
  photoJpegBase64?: string | null;
}

export interface TelegramBotSetup {
  botId: string;
  username: string;
  name: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
  profile: { name: boolean; description: boolean; photo: boolean };
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

/** The gemie's name, description and tagline, as its bot shows them. */
export async function telegramProfileOf(
  agent: AgentRecord,
  photoJpegBase64?: string | null,
): Promise<TelegramBotProfile> {
  const identity = await attachAgentIdentity(agent);
  return {
    name: agentPromptName(identity),
    description: agent.description || agent.tagline,
    shortDescription: agent.tagline || agent.description,
    photoJpegBase64: photoJpegBase64 ?? null,
  };
}

export function setUpTelegramBot(token: string, profile: TelegramBotProfile) {
  return call<TelegramBotSetup>('/setup', { token, profile });
}

export function updateTelegramBotProfile(token: string, profile: TelegramBotProfile) {
  return call<{ profile: TelegramBotSetup['profile'] }>('/profile', { token, profile });
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

/** Before a gemie is deleted: stop its bot and forget it. */
export async function releaseGemieTelegramBot(agentId: string): Promise<void> {
  const db = getDb();
  const token = await findGemieBotToken(db, agentId);
  if (token) await tearDownTelegramBot(token);
  await deleteGemieBot(db, agentId);
}
