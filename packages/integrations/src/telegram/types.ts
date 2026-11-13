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
  /** The user's IETF language tag, when Telegram sends one. */
  language_code?: string;
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

/** A file Telegram holds, fetched with `getFile` (a bot may download up to 20 MB). */
export interface TelegramFileRef {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

export interface TelegramPhotoSize extends TelegramFileRef {
  width: number;
  height: number;
}

export interface TelegramSticker extends TelegramFileRef {
  type: 'regular' | 'mask' | 'custom_emoji';
  is_animated: boolean;
  is_video: boolean;
  emoji?: string;
  set_name?: string;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramMediaFile extends TelegramFileRef {
  duration?: number;
  mime_type?: string;
  file_name?: string;
  title?: string;
  performer?: string;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramLocation {
  latitude: number;
  longitude: number;
}

/** Who a forwarded message came from (`MessageOrigin`). */
export type TelegramMessageOrigin =
  | { type: 'user'; date: number; sender_user: TelegramUser }
  | { type: 'hidden_user'; date: number; sender_user_name: string }
  | { type: 'chat'; date: number; sender_chat: TelegramChat }
  | { type: 'channel'; date: number; chat: TelegramChat };

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
  /** Part of a message quoted in a reply, when the person quoted only part of it. */
  quote?: { text: string };
  forward_origin?: TelegramMessageOrigin;
  photo?: TelegramPhotoSize[];
  sticker?: TelegramSticker;
  voice?: TelegramMediaFile;
  audio?: TelegramMediaFile;
  video?: TelegramMediaFile;
  video_note?: TelegramMediaFile;
  animation?: TelegramMediaFile;
  document?: TelegramMediaFile;
  location?: TelegramLocation;
  venue?: { location: TelegramLocation; title: string; address: string };
  contact?: { phone_number: string; first_name: string; last_name?: string };
  poll?: { question: string; options: Array<{ text: string }> };
  dice?: { emoji: string; value: number };
  /** Kinds this service does not read; named so the gemie can say so. */
  game?: unknown;
  story?: unknown;
  invoice?: unknown;
  paid_media?: unknown;
  business_connection_id?: string;
  /** The bot that sent an outgoing business message on the account's behalf. */
  sender_business_bot?: TelegramUser;
}

/** `getFile`: where a file can be downloaded from, for an hour. */
export interface TelegramFile extends TelegramFileRef {
  file_path?: string;
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
  edited_message?: TelegramMessage;
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
