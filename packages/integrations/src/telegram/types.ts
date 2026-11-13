/**
 * The parts of Telegram's Bot API objects this service reads (https://core.telegram.org/bots/api).
 * Only the fields used are typed; Telegram adds fields freely, so nothing here is exhaustive.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

/** `getMe`: the bot itself, with what only `getMe` reports. */
export interface TelegramBotUser extends TelegramUser {
  can_join_groups?: boolean;
  /** False while privacy mode is on: in a group the bot sees only commands and replies to it. */
  can_read_all_group_messages?: boolean;
  /** Whether Business mode is on in @BotFather, so people can connect it to their account. */
  can_connect_to_business?: boolean;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  business_connection_id?: string;
  /** The bot that sent an outgoing business message on the account's behalf. */
  sender_business_bot?: TelegramUser;
}

/** A Telegram Business account's grant to the bot. Only the right this service uses is typed. */
export interface TelegramBusinessBotRights {
  /** Send and edit messages in private chats that received a message in the last 24 hours. */
  can_reply?: boolean;
  [right: string]: boolean | undefined;
}

export interface TelegramBusinessConnection {
  id: string;
  user: TelegramUser;
  user_chat_id: number;
  date: number;
  rights?: TelegramBusinessBotRights;
  is_enabled: boolean;
}

export interface TelegramBusinessMessagesDeleted {
  business_connection_id: string;
  chat: TelegramChat;
  message_ids: number[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  business_connection?: TelegramBusinessConnection;
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  deleted_business_messages?: TelegramBusinessMessagesDeleted;
}

export interface TelegramWebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  allowed_updates?: string[];
}

/** One file of a multipart call: the form field it fills and its bytes. */
export interface TelegramInputFileUpload {
  field: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}
