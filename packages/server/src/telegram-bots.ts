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
  };
  /** The text, without the bot's @handle. */
  readonly text: string;
  /** Whether it mentions the bot, names it in a command, or replies to it. */
  readonly mentionsBot: boolean;
}

/** The API's answer: what the gemie says, or `null` when it does not answer. */
export interface GemieTelegramBotAnswer {
  readonly reply: string | null;
}
