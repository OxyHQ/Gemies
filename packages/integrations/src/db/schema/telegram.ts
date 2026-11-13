/**
 * Telegram on the official Bot API (ADR 0037): the updates Telegram delivered, and the Telegram
 * Business connections people make to the shared Gemies bot, with what arrives through them.
 *
 * Nothing here is a Telegram credential. The shared bot's token is the process's own
 * (`TELEGRAM_BOT_TOKEN`); a gemie's own bot token lives encrypted in the API's `bots` table. A
 * business connection is Telegram's grant to the bot, kept until the person ends it in Telegram:
 * nothing here expires one. Decisions common to the messaging domains are in `CONVENTIONS.md`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { checkOneOf } from './columns';

export const TELEGRAM_UPDATE_STATUSES = ['received', 'processing', 'done', 'failed'] as const;
export type TelegramUpdateStatus = (typeof TELEGRAM_UPDATE_STATUSES)[number];

/**
 * An update Telegram delivered to one of our bots, from acceptance until it is handled.
 *
 * Telegram never redelivers an update its webhook acknowledged, so the update is written here
 * BEFORE the acknowledgement and handled after it; a process that dies in between leaves a row the
 * sweep picks up on the next start (`telegram/inbox.ts`). `(bot_id, update_id)` is Telegram's own
 * identity, so a redelivery after a failed acknowledgement is recognised on any instance.
 *
 * `payload` holds message text, so it is cleared the moment the row settles.
 */
export const telegramUpdates = pgTable(
  'telegram_updates',
  {
    botId: text().notNull(),
    updateId: bigint({ mode: 'number' }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>(),
    status: text({ enum: TELEGRAM_UPDATE_STATUSES }).notNull().default('received'),
    attempts: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.updateId] }),
    index('telegram_updates_pending_idx')
      .on(t.updatedAt)
      .where(sql`${t.status} in ('received', 'processing')`),
    checkOneOf('telegram_updates_status_check', t.status, TELEGRAM_UPDATE_STATUSES),
  ],
);

/**
 * A Telegram Business connection to the shared bot, as Telegram last reported it: one per Telegram
 * account (Telegram allows one chatbot per account, and a new connection replaces the old one).
 *
 * Kept while Telegram reports it disabled (`is_enabled = false`): the person turned the bot off or
 * removed it in Telegram's settings, and adding it back enables the same account again with
 * nothing to do in Gemies.
 */
export const telegramBusinessConnections = pgTable(
  'telegram_business_connections',
  {
    telegramUserId: text().primaryKey(),
    connectionId: text().notNull(),
    /** The bot's private chat with the person, where the bot may write to them. */
    userChatId: text().notNull(),
    username: text(),
    displayName: text(),
    isEnabled: boolean().notNull(),
    /** `rights.can_reply`: whether the bot may write in the account's recent private chats. */
    canReply: boolean().notNull().default(false),
    rights: jsonb().$type<Record<string, boolean>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('telegram_business_connections_connection_key').on(t.connectionId)],
);

/**
 * A person's link between their Telegram account and one connected account of a gemie (the API's
 * `connected_accounts.session_id`).
 *
 * Linked in two steps, in either order: the person opens the bot from the panel's link, which
 * carries `link_code` and tells the bot which Telegram account is theirs (`telegram_user_id`), and
 * they connect the bot in Telegram › Settings › Telegram Business › Chatbots. A Telegram account
 * links to one session at a time: linking it again moves it, and the session it left is
 * `released_at`.
 */
export const telegramBusinessSessions = pgTable(
  'telegram_business_sessions',
  {
    sessionId: generatedId(),
    oxyUserId: text().notNull(),
    /** A one-time code the panel's link carries, valid until `link_code_expires_at`. */
    linkCode: text(),
    linkCodeExpiresAt: timestamptz(),
    telegramUserId: text(),
    /** When its Telegram account was linked to another session instead. */
    releasedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('telegram_business_sessions_oxy_user_id_idx').on(t.oxyUserId),
    uniqueIndex('telegram_business_sessions_link_code_key')
      .on(t.linkCode)
      .where(sql`${t.linkCode} is not null`),
    uniqueIndex('telegram_business_sessions_telegram_user_key')
      .on(t.telegramUserId)
      .where(sql`${t.telegramUserId} is not null`),
  ],
);

/** A private chat of a linked Telegram Business account, as seen since it was connected. */
export const telegramBusinessChats = pgTable(
  'telegram_business_chats',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => telegramBusinessSessions.sessionId, { onDelete: 'cascade' }),
    chatId: text().notNull(),
    name: text().notNull(),
    unreadCount: integer().notNull().default(0),
    /** Telegram's own epoch seconds, echoed verbatim — see `CONVENTIONS.md`. */
    lastMessageAt: bigint({ mode: 'number' }).notNull(),
    lastMessagePreview: text().notNull().default(''),
    /** When the contact last wrote: Telegram lets the bot reply for 24 hours after that. */
    lastIncomingAt: bigint({ mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('telegram_business_chats_session_chat_key').on(t.sessionId, t.chatId),
    index('telegram_business_chats_session_recent_idx').on(t.sessionId, t.lastMessageAt.desc()),
  ],
);

/** A message of a linked Telegram Business account's private chat. */
export const telegramBusinessMessages = pgTable(
  'telegram_business_messages',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => telegramBusinessSessions.sessionId, { onDelete: 'cascade' }),
    chatId: text().notNull(),
    messageId: text().notNull(),
    /** Written by the account (the person, or the gemie on their behalf). */
    fromMe: boolean().notNull(),
    senderName: text(),
    text: text().notNull().default(''),
    at: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('telegram_business_messages_session_message_key').on(
      t.sessionId,
      t.chatId,
      t.messageId,
    ),
    index('telegram_business_messages_session_chat_recent_idx').on(
      t.sessionId,
      t.chatId,
      t.at.desc(),
    ),
  ],
);
