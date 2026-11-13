/**
 * Telegram's official Bot API, the one client every Telegram path here speaks through (ADR 0037):
 * the shared Gemies bot (Telegram Business connections) and each gemie's own bot.
 *
 * Plain HTTPS to `api.telegram.org`, no SDK: the Bot API is a JSON-over-POST interface, and the few
 * methods used here are typed in `./types.ts`. A token never appears in a log line or an error:
 * the URL that carries it is built here and nowhere else.
 */

import type {
  TelegramBotUser,
  TelegramFile,
  TelegramInputFileUpload,
  TelegramMessage,
  TelegramWebhookInfo,
} from './types';

const BOT_API = 'https://api.telegram.org';

/** How long one call may take before it is given up as unreachable. */
const CALL_TIMEOUT_MS = 20_000;

/** What Telegram answered when it refused a call, without the token that made it. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    /** Telegram's `error_code` (an HTTP status), or 0 when it could not be reached. */
    readonly code: number,
    readonly description: string,
    /** Seconds Telegram asked to wait before retrying (`parameters.retry_after`), when it did. */
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface BotApiAnswer<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** The bot's numeric id, which is the token's first half and how a bot is named everywhere here. */
export function botIdOfToken(token: string): string {
  return token.slice(0, token.indexOf(':'));
}

/** Whether a string has the shape @BotFather gives a token: `<digits>:<35+ url-safe chars>`. */
export function looksLikeBotToken(value: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(value);
}

export class BotApi {
  readonly botId: string;

  constructor(private readonly token: string) {
    this.botId = botIdOfToken(token);
  }

  /** Call a method with JSON parameters and return its `result`, or throw `TelegramApiError`. */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.send<T>(method, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }

  /** Call a method that uploads files, as `multipart/form-data`. */
  async upload<T>(
    method: string,
    params: Record<string, unknown>,
    files: readonly TelegramInputFileUpload[],
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    for (const file of files) {
      form.append(
        file.field,
        new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
        file.filename,
      );
    }
    return this.send<T>(method, { body: form });
  }

  private async send<T>(method: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${BOT_API}/bot${this.token}/${method}`, {
        method: 'POST',
        ...init,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      // The cause may quote the URL, and the URL carries the token: only its kind is kept.
      const kind = error instanceof Error ? error.name : 'NetworkError';
      throw new TelegramApiError(method, 0, `Telegram could not be reached (${kind})`);
    }
    const answer = (await response.json().catch(() => null)) as BotApiAnswer<T> | null;
    if (!answer?.ok || answer.result === undefined) {
      throw new TelegramApiError(
        method,
        answer?.error_code ?? response.status,
        answer?.description ?? `HTTP ${response.status}`,
        answer?.parameters?.retry_after,
      );
    }
    return answer.result;
  }

  /**
   * Download a file a message carries, or `null` when Telegram will not hand it to a bot (over
   * 20 MB) or it is over `maxBytes`. The download URL carries the token, so it stays here too.
   */
  async downloadFile(fileId: string, maxBytes: number): Promise<Buffer | null> {
    const file = await this.call<TelegramFile>('getFile', { file_id: fileId });
    if (!file.file_path || (file.file_size ?? 0) > maxBytes) return null;
    let response: Response;
    try {
      response = await fetch(`${BOT_API}/file/bot${this.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS * 3),
      });
    } catch (error: unknown) {
      const kind = error instanceof Error ? error.name : 'NetworkError';
      throw new TelegramApiError('getFile', 0, `The file could not be downloaded (${kind})`);
    }
    if (!response.ok) {
      throw new TelegramApiError('getFile', response.status, `HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > maxBytes ? null : bytes;
  }

  /** React to a message with one emoji (or clear the bot's reaction with `null`). */
  setMessageReaction(chatId: string, messageId: number, emoji: string | null): Promise<true> {
    return this.call<true>('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    });
  }

  /** Send a photo Telegram fetches from a URL, with an optional caption. */
  sendPhoto(params: {
    chatId: string;
    photo: string;
    caption?: string;
    businessConnectionId?: string;
    replyToMessageId?: number;
  }): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendPhoto', {
      chat_id: params.chatId,
      photo: params.photo,
      ...(params.caption ? { caption: params.caption } : {}),
      ...(params.businessConnectionId
        ? { business_connection_id: params.businessConnectionId }
        : {}),
      ...(params.replyToMessageId
        ? {
            reply_parameters: {
              message_id: params.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
    });
  }

  getMe(): Promise<TelegramBotUser> {
    return this.call<TelegramBotUser>('getMe');
  }

  getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.call<TelegramWebhookInfo>('getWebhookInfo');
  }

  setWebhook(input: {
    url: string;
    secretToken: string;
    allowedUpdates: readonly string[];
  }): Promise<true> {
    return this.call<true>('setWebhook', {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: input.allowedUpdates,
      max_connections: 20,
    });
  }

  deleteWebhook(): Promise<true> {
    return this.call<true>('deleteWebhook');
  }

  sendMessage(params: {
    chatId: string;
    text: string;
    parseMode?: 'HTML';
    businessConnectionId?: string;
    replyToMessageId?: number;
  }): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: params.chatId,
      text: params.text,
      ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
      ...(params.businessConnectionId
        ? { business_connection_id: params.businessConnectionId }
        : {}),
      ...(params.replyToMessageId
        ? {
            reply_parameters: {
              message_id: params.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  sendTyping(chatId: string, businessConnectionId?: string): Promise<true> {
    return this.call<true>('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
    });
  }
}
