/**
 * The Telegram Business rows (`db/schema/telegram.ts`): sessions, the connections Telegram reports,
 * and the chats and messages that arrive through them.
 */

import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { GemieAccountSession, GemieAccountStatus } from '@gemies/server/internal';
import { getDb } from '../../db';
import {
  telegramBusinessChats,
  telegramBusinessConnections,
  telegramBusinessMessages,
  telegramBusinessSessions,
} from '../../db/schema';

/** How long the code in a panel's link may be used. A code is single-use. */
const LINK_CODE_TTL_MS = 30 * 60_000;

export type BusinessConnectionRow = typeof telegramBusinessConnections.$inferSelect;

export interface BusinessSessionState {
  sessionId: string;
  oxyUserId: string;
  telegramUserId: string | null;
  releasedAt: Date | null;
  connection: BusinessConnectionRow | null;
}

/**
 * A session's status, derived from what Telegram last said and never stored, so it cannot drift:
 * waiting until both halves of the link are in, then connected or paused as Telegram reports the
 * connection, and over once its Telegram account was linked to another session.
 */
export function statusOf(state: BusinessSessionState): GemieAccountStatus {
  if (state.releasedAt) return 'logged-out';
  if (!state.telegramUserId || !state.connection) return 'qr-pending';
  return state.connection.isEnabled ? 'connected' : 'paused';
}

/** A Telegram user's name as people read it. */
export function nameOf(user: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(' ') ||
    (user.username ? `@${user.username}` : 'Telegram')
  );
}

/** The session as the API stores it. */
export function sessionReport(state: BusinessSessionState): GemieAccountSession {
  return {
    status: statusOf(state),
    phoneNumber: null,
    displayName: state.connection?.username
      ? `@${state.connection.username}`
      : (state.connection?.displayName ?? null),
    canReply: state.connection?.canReply ?? null,
  };
}

function newLinkCode(): { linkCode: string; linkCodeExpiresAt: Date } {
  return {
    // base64url: what a deep link's start parameter allows, 32 characters of the 64 it may hold.
    linkCode: randomBytes(24).toString('base64url'),
    linkCodeExpiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
  };
}

export async function createBusinessSession(
  oxyUserId: string,
): Promise<{ sessionId: string; linkCode: string }> {
  const code = newLinkCode();
  const [row] = await getDb()
    .insert(telegramBusinessSessions)
    .values({ oxyUserId, ...code })
    .returning({ sessionId: telegramBusinessSessions.sessionId });
  if (!row) throw new Error('The Telegram session was not created');
  return { sessionId: row.sessionId, linkCode: code.linkCode };
}

/**
 * The code a waiting session's link carries now: the current one while it is valid, a new one
 * once it expired. `null` when the session no longer waits for its link to be opened.
 */
export async function currentLinkCode(sessionId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({
      linkCode: telegramBusinessSessions.linkCode,
      linkCodeExpiresAt: telegramBusinessSessions.linkCodeExpiresAt,
      telegramUserId: telegramBusinessSessions.telegramUserId,
      releasedAt: telegramBusinessSessions.releasedAt,
    })
    .from(telegramBusinessSessions)
    .where(eq(telegramBusinessSessions.sessionId, sessionId));
  if (!row || row.telegramUserId || row.releasedAt) return null;
  if (row.linkCode && row.linkCodeExpiresAt && row.linkCodeExpiresAt.getTime() > Date.now()) {
    return row.linkCode;
  }
  const code = newLinkCode();
  await db
    .update(telegramBusinessSessions)
    .set(code)
    .where(eq(telegramBusinessSessions.sessionId, sessionId));
  return code.linkCode;
}

export async function findBusinessSessionOwner(sessionId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ oxyUserId: telegramBusinessSessions.oxyUserId })
    .from(telegramBusinessSessions)
    .where(eq(telegramBusinessSessions.sessionId, sessionId));
  return row?.oxyUserId ?? null;
}

export async function findBusinessConnectionOfUser(
  telegramUserId: string,
): Promise<BusinessConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(telegramBusinessConnections)
    .where(eq(telegramBusinessConnections.telegramUserId, telegramUserId));
  return row ?? null;
}

export async function findBusinessConnection(
  connectionId: string,
): Promise<BusinessConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(telegramBusinessConnections)
    .where(eq(telegramBusinessConnections.connectionId, connectionId));
  return row ?? null;
}

export async function readBusinessSession(sessionId: string): Promise<BusinessSessionState | null> {
  const [row] = await getDb()
    .select({
      sessionId: telegramBusinessSessions.sessionId,
      oxyUserId: telegramBusinessSessions.oxyUserId,
      telegramUserId: telegramBusinessSessions.telegramUserId,
      releasedAt: telegramBusinessSessions.releasedAt,
    })
    .from(telegramBusinessSessions)
    .where(eq(telegramBusinessSessions.sessionId, sessionId));
  if (!row) return null;
  const connection = row.telegramUserId
    ? await findBusinessConnectionOfUser(row.telegramUserId)
    : null;
  return { ...row, connection };
}

/** The live session a Telegram account is linked to, if any. */
export async function findSessionOfTelegramUser(
  telegramUserId: string,
): Promise<BusinessSessionState | null> {
  const [row] = await getDb()
    .select({ sessionId: telegramBusinessSessions.sessionId })
    .from(telegramBusinessSessions)
    .where(eq(telegramBusinessSessions.telegramUserId, telegramUserId));
  return row ? readBusinessSession(row.sessionId) : null;
}

/**
 * Link the Telegram account that opened a panel's link to that link's session, once: the code is
 * spent, and any other session the account was linked to is released (it now answers through
 * this one). `null` when no waiting session carries a valid `linkCode`. Answers the sessions it
 * released, whose status moved too.
 */
export async function claimLinkCode(
  linkCode: string,
  telegramUserId: string,
): Promise<{ sessionId: string; released: string[] } | null> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select({ sessionId: telegramBusinessSessions.sessionId })
      .from(telegramBusinessSessions)
      .where(
        and(
          eq(telegramBusinessSessions.linkCode, linkCode),
          gt(telegramBusinessSessions.linkCodeExpiresAt, new Date()),
          isNull(telegramBusinessSessions.telegramUserId),
          isNull(telegramBusinessSessions.releasedAt),
        ),
      )
      .for('update');
    if (!session) return null;
    const released = await tx
      .update(telegramBusinessSessions)
      .set({ telegramUserId: null, releasedAt: new Date() })
      .where(
        and(
          eq(telegramBusinessSessions.telegramUserId, telegramUserId),
          ne(telegramBusinessSessions.sessionId, session.sessionId),
        ),
      )
      .returning({ sessionId: telegramBusinessSessions.sessionId });
    await tx
      .update(telegramBusinessSessions)
      .set({ telegramUserId, linkCode: null, linkCodeExpiresAt: null })
      .where(eq(telegramBusinessSessions.sessionId, session.sessionId));
    return { sessionId: session.sessionId, released: released.map((row) => row.sessionId) };
  });
}

/** Record a connection as Telegram reports it: created, edited, disabled or enabled again. */
export async function saveBusinessConnection(input: {
  telegramUserId: string;
  connectionId: string;
  userChatId: string;
  username: string | null;
  displayName: string | null;
  isEnabled: boolean;
  rights: Record<string, boolean>;
}): Promise<{ isNew: boolean }> {
  const db = getDb();
  const before = await findBusinessConnectionOfUser(input.telegramUserId);
  const values = { ...input, canReply: input.rights.can_reply === true };
  await db
    .insert(telegramBusinessConnections)
    .values(values)
    .onConflictDoUpdate({ target: telegramBusinessConnections.telegramUserId, set: values });
  return { isNew: !before || before.connectionId !== input.connectionId };
}

export async function deleteBusinessSession(sessionId: string): Promise<void> {
  await getDb()
    .delete(telegramBusinessSessions)
    .where(eq(telegramBusinessSessions.sessionId, sessionId));
}

/** Store a message of a private chat and move the chat with it. A repeated message is updated. */
export async function recordBusinessMessage(input: {
  sessionId: string;
  chatId: string;
  chatName: string;
  messageId: string;
  fromMe: boolean;
  senderName: string | null;
  text: string;
  at: number;
}): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(telegramBusinessMessages)
      .values({
        sessionId: input.sessionId,
        chatId: input.chatId,
        messageId: input.messageId,
        fromMe: input.fromMe,
        senderName: input.senderName,
        text: input.text,
        at: input.at,
      })
      .onConflictDoNothing()
      .returning({ id: telegramBusinessMessages.id });
    if (inserted.length === 0) return;
    const preview = input.text.slice(0, 100);
    await tx
      .insert(telegramBusinessChats)
      .values({
        sessionId: input.sessionId,
        chatId: input.chatId,
        name: input.chatName,
        unreadCount: input.fromMe ? 0 : 1,
        lastMessageAt: input.at,
        lastMessagePreview: preview,
        lastIncomingAt: input.fromMe ? null : input.at,
      })
      .onConflictDoUpdate({
        target: [telegramBusinessChats.sessionId, telegramBusinessChats.chatId],
        set: {
          name: input.chatName,
          lastMessageAt: sql`greatest(${telegramBusinessChats.lastMessageAt}, ${input.at})`,
          lastMessagePreview: preview,
          // Writing in a chat reads it; every message from the contact after that is unread.
          unreadCount: input.fromMe ? 0 : sql`${telegramBusinessChats.unreadCount} + 1`,
          ...(input.fromMe
            ? {}
            : {
                lastIncomingAt: sql`greatest(coalesce(${telegramBusinessChats.lastIncomingAt}, 0), ${input.at})`,
              }),
        },
      });
  });
}

export async function editBusinessMessage(input: {
  sessionId: string;
  chatId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  await getDb()
    .update(telegramBusinessMessages)
    .set({ text: input.text })
    .where(
      and(
        eq(telegramBusinessMessages.sessionId, input.sessionId),
        eq(telegramBusinessMessages.chatId, input.chatId),
        eq(telegramBusinessMessages.messageId, input.messageId),
      ),
    );
}

export async function deleteBusinessMessages(input: {
  sessionId: string;
  chatId: string;
  messageIds: string[];
}): Promise<void> {
  if (input.messageIds.length === 0) return;
  await getDb()
    .delete(telegramBusinessMessages)
    .where(
      and(
        eq(telegramBusinessMessages.sessionId, input.sessionId),
        eq(telegramBusinessMessages.chatId, input.chatId),
        inArray(telegramBusinessMessages.messageId, input.messageIds),
      ),
    );
}

export function listBusinessChats(sessionId: string, limit: number) {
  return getDb()
    .select({
      chatId: telegramBusinessChats.chatId,
      name: telegramBusinessChats.name,
      unreadCount: telegramBusinessChats.unreadCount,
      lastMessageAt: telegramBusinessChats.lastMessageAt,
      lastMessagePreview: telegramBusinessChats.lastMessagePreview,
    })
    .from(telegramBusinessChats)
    .where(eq(telegramBusinessChats.sessionId, sessionId))
    .orderBy(desc(telegramBusinessChats.lastMessageAt))
    .limit(limit);
}

export async function findBusinessChat(sessionId: string, chatId: string) {
  const [row] = await getDb()
    .select({
      name: telegramBusinessChats.name,
      lastIncomingAt: telegramBusinessChats.lastIncomingAt,
    })
    .from(telegramBusinessChats)
    .where(
      and(eq(telegramBusinessChats.sessionId, sessionId), eq(telegramBusinessChats.chatId, chatId)),
    );
  return row ?? null;
}

/** A chat's latest messages, oldest first. */
export async function listBusinessMessages(sessionId: string, chatId: string, limit: number) {
  const rows = await getDb()
    .select({
      messageId: telegramBusinessMessages.messageId,
      fromMe: telegramBusinessMessages.fromMe,
      senderName: telegramBusinessMessages.senderName,
      text: telegramBusinessMessages.text,
      at: telegramBusinessMessages.at,
    })
    .from(telegramBusinessMessages)
    .where(
      and(
        eq(telegramBusinessMessages.sessionId, sessionId),
        eq(telegramBusinessMessages.chatId, chatId),
      ),
    )
    // Telegram's times are seconds; within one, the order they arrived in (uuidv7 ids).
    .orderBy(desc(telegramBusinessMessages.at), desc(telegramBusinessMessages.id))
    .limit(limit);
  return rows.reverse();
}
