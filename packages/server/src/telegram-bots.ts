import type { GemieChannelMessage, GemieTurnContentPart } from './channel-messages.js';

/**
 * The contract for a gemie's own Telegram bot between the Gemies API, which keeps the bot and runs
 * the gemie's turns, and its integrations process, which speaks Telegram's Bot API (ADR 0037).
 */

/** `GET /channel-bots/telegram`: a gemie's bot, with the token to speak as it. */
export interface GemieTelegramBot {
  /** Telegram's id for the bot: its token's first half. */
  readonly botId: string;
  readonly token: string;
  readonly username: string;
}

/** `POST /channel-bots/telegram/:botId/messages`: a message the bot received. */
export interface GemieTelegramBotMessage {
  readonly chatId: string;
  readonly chatKind: 'direct' | 'group';
  /** A group's title; `null` in a private chat. */
  readonly chatTitle: string | null;
  readonly messageId: string;
  readonly from: {
    readonly id: string;
    readonly username: string | null;
    readonly name: string;
    /** Telegram's IETF language tag for the sender, when it sends one. */
    readonly languageCode?: string | null;
  };
  /** What it carries, its text without the bot's @handle. */
  readonly message: GemieChannelMessage;
  /** Whether it mentions the bot, names it in a command, or replies to it. */
  readonly mentionsBot: boolean;
  /** A message the person edited: the stored one is updated, and nothing is answered. */
  readonly edited?: boolean;
}

/**
 * The API's answer: what the gemie says (`null` when it does not answer), and an emoji it reacts to
 * the message with, when it chose to.
 *
 * `personTurn` instead of a reply: the person who connected the bot wrote, in private, from the
 * Telegram account they linked to it. Their turn is theirs, run like any of their turns in the app
 * (`POST /alia/chat` as the `gemie_bot` channel identity) in this conversation, with the user
 * message the API prepared (`content`: its words and its kept media) stored under `messageId`.
 */
export interface GemieTelegramBotAnswer {
  readonly reply: string | null;
  readonly reaction?: string | null;
  readonly personTurn?: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly content: readonly GemieTurnContentPart[];
  };
}

/** `POST /telegram/bots/send` of the integrations process: the gemie writes first, in a chat of its bot. */
export interface GemieTelegramBotSend {
  readonly token: string;
  readonly chatId: string;
  readonly text: string;
}
