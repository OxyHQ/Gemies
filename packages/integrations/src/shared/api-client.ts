import {
  GEMIES_CHANNEL_BOT_HEADER,
  GEMIES_CHANNEL_HEADER,
  GEMIES_PLATFORM_USER_HEADER,
  GEMIES_CHANNEL_SESSION_HEADER,
  type GemieAccountInbound,
  type GemieAccountInboundDecision,
  type GemieAccountIncoming,
  type GemieAccountSession,
  type GemieAccountTurnContent,
  type GemieChannelIdentity,
  type GemieTelegramBot,
  type GemieTelegramBotAnswer,
  type GemieTelegramBotMessage,
  type GemieTurnContentPart,
} from '@gemies/server/internal';

export type TelegramBotMessage = GemieTelegramBotMessage;
import { aliaApiFetch } from './oxy';
import { errorStatus } from './utils';
import { parseCatalogue, resolveRequestModel, type Catalogue } from './catalogue';

/** A message's content: plain text, or its parts (words, and Oxy Files `file` parts). */
export type MessageContent = string | readonly GemieTurnContentPart[];

/** A bot user record linking a platform identity to an Oxy account. */
export interface BotUser {
  oxyUserId: string;
  platformUserId: string;
  conversationId?: string;
  model?: string;
  preferredModel?: string;
  isLinked?: boolean;
  linkedAt?: string;
  displayName?: string;
  username?: string;
  [key: string]: unknown;
}

/** A single stored conversation message. */
export interface ConversationMessage {
  role: string;
  content: MessageContent;
  [key: string]: unknown;
}

/** A stored conversation with its message history. */
export interface Conversation {
  conversationId?: string;
  id?: string;
  title?: string;
  messages?: ConversationMessage[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** The longest a channel turn may run, start to end (the stream keeps it open meanwhile). */
const CHAT_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * Read a `/alia/chat` stream to its end: the answer's text, and how it finished. An error the
 * turn sent after the stream opened (`data: {"error": …}`) is thrown, like a refused request.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ content: string; finishReason: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = 'stop';
  const take = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return true;
    let frame: {
      error?: { message?: string; code?: unknown };
      choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }>;
    };
    try {
      frame = JSON.parse(data);
    } catch {
      return false;
    }
    if (frame.error) {
      throw Object.assign(new Error(`Alia turn failed: ${frame.error.message ?? 'error'}`), {
        code: frame.error.code,
      });
    }
    const choice = frame.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    return false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (take(line)) return { content, finishReason };
    }
    if (buffer) take(buffer);
  } finally {
    reader.releaseLock();
  }
  return { content, finishReason };
}

/** How long a catalogue is reused before it is asked for again. */
const CATALOGUE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Parameterized API client — one instance per platform, all sharing the same core logic.
 */
export class APIClient {
  private client = {
    get: (path: string, options?: { headers?: HeadersInit; timeout?: number }) =>
      this.jsonRequest('GET', path, undefined, options),
    post: (path: string, body: unknown, options?: { headers?: HeadersInit; timeout?: number }) =>
      this.jsonRequest('POST', path, body, options),
  };
  private platform: string;
  private cachedCatalogue: Catalogue | null = null;
  private cachedCatalogueAt = 0;

  constructor(platform: string) {
    this.platform = platform;
  }

  private get authHeaders(): Record<string, string> {
    return { [GEMIES_CHANNEL_HEADER]: this.platform };
  }

  private accountHeaders(identity: GemieChannelIdentity): Record<string, string> {
    return {
      ...this.authHeaders,
      ...(identity.kind === 'account'
        ? { [GEMIES_CHANNEL_SESSION_HEADER]: identity.sessionId }
        : { [GEMIES_PLATFORM_USER_HEADER]: identity.platformUserId }),
      ...(identity.kind === 'gemie_bot' ? { [GEMIES_CHANNEL_BOT_HEADER]: identity.botId } : {}),
    };
  }

  private async jsonRequest(
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: HeadersInit; timeout?: number } = {},
  ): Promise<{ data: any }> {
    const headers = new Headers(options.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await aliaApiFetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeout ?? 30_000),
    });
    if (!response.ok) {
      const error = Object.assign(new Error(`Alia request failed (${response.status})`), {
        status: response.status,
      });
      throw error;
    }
    return { data: await response.json() };
  }

  async getBotUser(platformUserId: string): Promise<BotUser | null> {
    try {
      const response = await this.client.get(
        `/bots/internal/${this.platform}/users/${platformUserId}`,
        { headers: this.authHeaders },
      );
      return response.data;
    } catch (error: unknown) {
      if (errorStatus(error) === 404) return null;
      throw error;
    }
  }

  async createOrUpdateBotUser(data: {
    platformUserId: string;
    chatId: string;
    username?: string;
    displayName?: string;
  }): Promise<BotUser> {
    const response = await this.client.post(`/bots/internal/${this.platform}/users`, data, {
      headers: this.authHeaders,
    });
    return response.data;
  }

  async requestAuthToken(platformUserId: string): Promise<{
    authToken: string;
    authUrl: string;
    expiresAt: Date;
  }> {
    const response = await this.client.post(
      `/bots/internal/${this.platform}/auth-request`,
      { platformUserId },
      { headers: this.authHeaders },
    );
    return response.data;
  }

  async updateConversation(platformUserId: string, conversationId: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${platformUserId}/conversation`,
      { conversationId },
      { headers: this.authHeaders },
    );
  }

  /** Whether the account's gemie answers a message that arrived on it (`POST /channel-accounts/inbound`). */
  async decideInbound(
    identity: GemieChannelIdentity,
    inbound: GemieAccountInbound,
  ): Promise<GemieAccountInboundDecision> {
    const response = await this.client.post('/channel-accounts/inbound', inbound, {
      headers: this.accountHeaders(identity),
    });
    return response.data as GemieAccountInboundDecision;
  }

  /**
   * A message the account's gemie answers, as its turn carries it (`POST /channel-accounts/messages`):
   * the API keeps its media in the person's Oxy Files and answers the user message's content.
   */
  async prepareAccountMessage(
    identity: GemieChannelIdentity,
    incoming: GemieAccountIncoming,
  ): Promise<GemieAccountTurnContent> {
    const response = await this.client.post('/channel-accounts/messages', incoming, {
      headers: this.accountHeaders(identity),
      timeout: 120_000,
    });
    return response.data as GemieAccountTurnContent;
  }

  /** A connected account's session moved (`POST /channel-accounts/session`): the API stores it. */
  async reportAccountSession(sessionId: string, session: GemieAccountSession): Promise<void> {
    await this.client.post('/channel-accounts/session', session, {
      headers: this.accountHeaders({ kind: 'account', sessionId }),
    });
  }

  /** Every gemie's own Telegram bot, with the token to speak as it (`GET /channel-bots/telegram`). */
  async listTelegramBots(): Promise<GemieTelegramBot[]> {
    const response = await this.client.get('/channel-bots/telegram', { headers: this.authHeaders });
    return (response.data as { bots: GemieTelegramBot[] }).bots;
  }

  /**
   * What a gemie answers to a message its own Telegram bot received, or `null` when it does not
   * answer it. The turn runs in the API, so this waits for it.
   */
  async answerTelegramBotMessage(
    botId: string,
    message: GemieTelegramBotMessage,
  ): Promise<GemieTelegramBotAnswer> {
    const response = await this.client.post(
      `/channel-bots/telegram/${encodeURIComponent(botId)}/messages`,
      message,
      // The API keeps the answer's connection alive while the turn runs, and runs it once.
      { headers: this.authHeaders, timeout: 5 * 60_000 },
    );
    return response.data as GemieTelegramBotAnswer;
  }

  async getConversation(
    identity: GemieChannelIdentity,
    conversationId: string,
  ): Promise<Conversation | null> {
    try {
      const response = await this.client.get(
        `/conversations/${encodeURIComponent(conversationId)}`,
        {
          headers: this.accountHeaders(identity),
        },
      );
      return response.data;
    } catch (error: unknown) {
      if (errorStatus(error) === 404) return null;
      throw error;
    }
  }

  async saveConversation(
    identity: GemieChannelIdentity,
    conversationId: string,
    messages: ConversationMessage[],
    title?: string,
  ): Promise<Conversation> {
    const response = await this.client.post(
      '/conversations',
      { conversationId, messages, title },
      { headers: this.accountHeaders(identity) },
    );
    return response.data;
  }

  async getConversations(identity: GemieChannelIdentity): Promise<Conversation[]> {
    const response = await this.client.get('/conversations', {
      headers: this.accountHeaders(identity),
    });
    return response.data;
  }

  /**
   * The model catalogue (`GET /catalogue`), or `null` when it could not be read.
   *
   * No provider-link context is attached: the catalogue is public, so one would
   * buy nothing and widen where it travels. `null` rather than an empty
   * catalogue, because "no models" and "we could not ask" are different
   * answers. A failure is NOT cached, and the previous success is not kept
   * across it: a stale listing can still offer a withdrawn model.
   *
   * Cached per client, so `/status`, `/model` and every chat turn share one
   * request per window.
   */
  async fetchCatalogue(): Promise<Catalogue | null> {
    if (
      this.cachedCatalogue !== null &&
      Date.now() - this.cachedCatalogueAt < CATALOGUE_CACHE_TTL_MS
    ) {
      return this.cachedCatalogue;
    }
    try {
      const response = await this.client.get('/catalogue');
      this.cachedCatalogue = parseCatalogue(response.data);
      this.cachedCatalogueAt = Date.now();
      return this.cachedCatalogue;
    } catch {
      this.cachedCatalogue = null;
      return null;
    }
  }

  /**
   * The `model` a chat request should carry for a stored choice, or
   * `undefined` to omit it and let the server use its default. See
   * `resolveRequestModel` in `./catalogue.ts`.
   */
  async requestModel(chosen: string | null | undefined): Promise<string | undefined> {
    return resolveRequestModel(chosen, await this.fetchCatalogue());
  }

  /** Store a person's model, or clear it (`null`) back to the server default. */
  async updateModel(platformUserId: string, model: string | null): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${platformUserId}/model`,
      { model },
      { headers: this.authHeaders },
    );
  }

  async logoutUser(platformUserId: string): Promise<void> {
    await this.client.post(
      `/bots/internal/${this.platform}/users/${platformUserId}/logout`,
      {},
      { headers: this.authHeaders },
    );
  }

  // ---------------------------------------------------------------------------
  // Chat completions — route AI calls through the main API
  // ---------------------------------------------------------------------------

  /**
   * Shared product chat transport; channel identity is resolved live by Alia.
   *
   * Streamed, and read to the end here: the stream's keep-alive comments hold the connection open
   * however long the turn takes. A JSON answer could not outlast the load balancer's 60 s idle
   * timeout, which answered 504 while the turn went on and was saved, so its caller apologised (or
   * retried) for a turn that had in fact answered.
   */
  async chatCompletion(
    identity: GemieChannelIdentity,
    messages: Array<{ id?: string; role: string; content: MessageContent }>,
    options: { model?: string; conversationId?: string } = {},
  ): Promise<{ content: string; finishReason: string }> {
    const response = await aliaApiFetch(`/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.accountHeaders(identity),
      },
      body: JSON.stringify({
        // Omitted when unset, exactly like `conversationId` beneath it:
        // `JSON.stringify` drops an `undefined` value, and a request that names
        // no model uses the server's own default. Callers resolve it through
        // `requestModel`. Naming an id here would bake a second, silent default
        // into this service, one no catalogue change could ever reach.
        messages,
        model: options.model,
        stream: true,
        conversationId: options.conversationId,
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(CHAT_TURN_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      const err: Error & { status?: number; code?: unknown } = new Error(
        `Alia request failed (${response.status})`,
      );
      err.status = response.status;
      err.code = body.error?.code;
      throw err;
    }
    if (!response.body) throw new Error('Alia answered no stream');
    return readChatStream(response.body);
  }
}
