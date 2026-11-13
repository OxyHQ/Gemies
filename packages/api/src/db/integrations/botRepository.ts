/**
 * System bots and the people who link their own account to them, on Postgres. A gemie's own
 * Telegram bot is `gemieBotRepository.ts`.
 *
 * ## `bot_users.auth_token` is PLAINTEXT
 *
 * The redemption path finds a row by it, paired with its expiry; `encryptedText` (AES-GCM with a
 * random IV) could never match an equality lookup. If it ever has to go, the replacement is a
 * deterministic keyed digest stored beside it, never encryption of the token itself.
 *
 * ## There is no projection default, so the projections carry it
 *
 * `bots.bot_token` must stay out of every query that does not ask. drizzle returns whatever the
 * column list names, so `BotRow` is everything the routes render, without it.
 *
 * ## The system bot is `user_id IS NULL`, and every lookup must say so
 *
 * Getting it backwards binds a global flow to somebody's private bot, which is why
 * `findSystemBot` is a named function rather than a `userId?` parameter whose absence would read
 * as "any".
 */

import { and, desc, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { botUsers, bots, type BotStatus, type BotUserAuthTokenMode } from '../schema/bots';

/** A bot as stored, WITHOUT either credential. */
export interface BotRow {
  _id: string;
  id: string;
  platform: string;
  botId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  status: BotStatus;
  userId: string | null;
  agentId: string | null;
  /** The owner's consent to fund the agent's turns. See `schema/bots.ts`. */
  ownerPaysAgentTurns: boolean;
  defaultModel: string | null;
  totalUsers: number;
  totalMessages: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Named columns, and neither credential is among them.
 *
 * `platform_config_webhook_url` / `_public_key` are absent too: every read of a
 * bot in the routes said `.select('-platformConfig')`.
 */
const BOT_COLUMNS = {
  id: bots.id,
  platform: bots.platform,
  botId: bots.botId,
  name: bots.name,
  username: bots.username,
  avatarUrl: bots.avatarUrl,
  status: bots.status,
  userId: bots.userId,
  agentId: bots.agentId,
  ownerPaysAgentTurns: bots.ownerPaysAgentTurns,
  defaultModel: bots.defaultModel,
  totalUsers: bots.totalUsers,
  totalMessages: bots.totalMessages,
  lastMessageAt: bots.lastMessageAt,
  createdAt: bots.createdAt,
  updatedAt: bots.updatedAt,
} as const;

function withLegacyId(row: Omit<BotRow, '_id'>): BotRow {
  return { _id: row.id, ...row };
}

/**
 * The SYSTEM bot for a platform — the env-configured global one.
 *
 * `isNull(userId)` is `userId: { $exists: false }`. A bot registered by a user
 * can never match, which is what stops a global flow binding to a private bot.
 */
export async function findSystemBot(
  db: ApiDatabase,
  platform: string,
  options: { activeOnly?: boolean } = {},
): Promise<BotRow | null> {
  const [row] = await db
    .select(BOT_COLUMNS)
    .from(bots)
    .where(
      options.activeOnly
        ? and(eq(bots.platform, platform), isNull(bots.userId), eq(bots.status, 'active'))
        : and(eq(bots.platform, platform), isNull(bots.userId)),
    )
    .limit(1);

  return row ? withLegacyId(row) : null;
}

/** One bot by id, without credentials. */
export async function findBotById(db: ApiDatabase, id: string): Promise<BotRow | null> {
  const [row] = await db.select(BOT_COLUMNS).from(bots).where(eq(bots.id, id)).limit(1);
  return row ? withLegacyId(row) : null;
}

// ---------------------------------------------------------------------------
// bot_users
// ---------------------------------------------------------------------------

/** One person's relationship with one bot. `auth_token` is never projected. */
export interface BotUserRow {
  id: string;
  botId: string;
  platform: string;
  platformUserId: string;
  chatId: string;
  oxyUserId: string | null;
  oxyTaskId: string | null;
  oxyTaskState: 'active' | 'reauth_required';
  isLinked: boolean;
  linkedAt: Date | null;
  username: string | null;
  displayName: string | null;
  authTokenExpiry: Date | null;
  authTokenMode: BotUserAuthTokenMode | null;
  conversationId: string | null;
  preferredModel: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const BOT_USER_COLUMNS = {
  id: botUsers.id,
  botId: botUsers.botId,
  platform: botUsers.platform,
  platformUserId: botUsers.platformUserId,
  chatId: botUsers.chatId,
  oxyUserId: botUsers.oxyUserId,
  oxyTaskId: botUsers.oxyTaskId,
  oxyTaskState: botUsers.oxyTaskState,
  isLinked: botUsers.isLinked,
  linkedAt: botUsers.linkedAt,
  username: botUsers.username,
  displayName: botUsers.displayName,
  authTokenExpiry: botUsers.authTokenExpiry,
  authTokenMode: botUsers.authTokenMode,
  conversationId: botUsers.conversationId,
  preferredModel: botUsers.preferredModel,
  metadata: sql<Record<string, unknown>>`${botUsers.metadata} - 'sessionToken'`,
  createdAt: botUsers.createdAt,
  updatedAt: botUsers.updatedAt,
} as const;

/** One bot user by its own id. */
export async function findBotUserById(db: ApiDatabase, id: string): Promise<BotUserRow | null> {
  const [row] = await db
    .select(BOT_USER_COLUMNS)
    .from(botUsers)
    .where(eq(botUsers.id, id))
    .limit(1);
  return row ?? null;
}

/** One bot user by the platform's id for the person. */
export async function findBotUser(
  db: ApiDatabase,
  botId: string,
  platformUserId: string,
): Promise<BotUserRow | null> {
  const [row] = await db
    .select(BOT_USER_COLUMNS)
    .from(botUsers)
    .where(and(eq(botUsers.botId, botId), eq(botUsers.platformUserId, platformUserId)))
    .limit(1);

  return row ?? null;
}

/** This Oxy account's LINKED relationship with a bot, if there is one. */
export async function findLinkedBotUser(
  db: ApiDatabase,
  botId: string,
  oxyUserId: string,
): Promise<BotUserRow | null> {
  const [row] = await db
    .select(BOT_USER_COLUMNS)
    .from(botUsers)
    .where(
      and(
        eq(botUsers.botId, botId),
        eq(botUsers.oxyUserId, oxyUserId),
        eq(botUsers.isLinked, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * The bot user holding this UNEXPIRED auth token.
 *
 * The second by-value lookup on a plaintext credential, and the reason
 * `bot_users.auth_token` is not `encryptedText`. The expiry is part of the
 * predicate rather than a check afterwards, exactly as
 * `authTokenExpiry: { $gt: new Date() }` was — a caller that read the row and
 * forgot to compare would honour an expired link token.
 */
export async function findBotUserByAuthToken(
  db: ApiDatabase,
  botId: string,
  authToken: string,
  now: Date = new Date(),
): Promise<BotUserRow | null> {
  const [row] = await db
    .select(BOT_USER_COLUMNS)
    .from(botUsers)
    .where(
      and(
        eq(botUsers.botId, botId),
        eq(botUsers.authToken, authToken),
        gt(botUsers.authTokenExpiry, now),
      ),
    )
    .limit(1);

  return row ?? null;
}

export interface UpsertBotUser {
  readonly botId: string;
  readonly platform: string;
  readonly platformUserId: string;
  readonly chatId: string;
  readonly username?: string | undefined;
  readonly displayName?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Create the relationship, or refresh the identity fields on an existing one.
 *
 * The source read, branched, and either constructed or mutated — a
 * read-then-write race two concurrent inbound messages from the same person can
 * lose. `ON CONFLICT … DO UPDATE` on `bot_users_bot_platform_user_key` is one
 * statement, so the loser converges instead of failing.
 *
 * Only the fields the source touched are updated, and each only when SUPPLIED —
 * `if (username) botUser.username = username` — so an update carrying no display
 * name does not blank the stored one. `metadata` MERGES, matching
 * `{ ...botUser.metadata, ...metadata }`, which is `||` on `jsonb`.
 */
export async function upsertBotUser(db: ApiDatabase, input: UpsertBotUser): Promise<BotUserRow> {
  const [row] = await db
    .insert(botUsers)
    .values({
      botId: input.botId,
      platform: input.platform,
      platformUserId: input.platformUserId,
      chatId: input.chatId,
      username: input.username ?? null,
      displayName: input.displayName ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [botUsers.botId, botUsers.platformUserId],
      set: {
        chatId: input.chatId,
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.metadata === undefined
          ? {}
          : { metadata: sql`${botUsers.metadata} || ${JSON.stringify(input.metadata)}::jsonb` }),
      },
    })
    .returning(BOT_USER_COLUMNS);

  if (!row) throw new Error('bot user upsert returned no row');
  return row;
}

/**
 * Redeem a link token: bind the Oxy account and CLEAR the token.
 *
 * The clearing is the security-relevant half. `.set({ authToken: undefined })`
 * in drizzle is a silent no-op, so a redeemed one-time link token cleared that
 * way would stay live until its 15-minute
 * expiry and could be redeemed again, by anyone holding it, into a DIFFERENT
 * account. Explicit `null` is what makes it single-use.
 */
export async function linkBotUser(
  db: ApiDatabase,
  id: string,
  input: { oxyUserId: string; oxyTaskId: string; authToken?: string },
): Promise<BotUserRow | null> {
  const [row] = await db
    .update(botUsers)
    .set({
      oxyUserId: input.oxyUserId,
      isLinked: true,
      linkedAt: new Date(),
      authToken: null,
      authTokenExpiry: null,
      oxyTaskId: input.oxyTaskId,
      oxyTaskState: 'active',
      metadata: sql`${botUsers.metadata} - 'sessionToken'`,
    })
    .where(
      and(
        eq(botUsers.id, id),
        ...(input.authToken
          ? [eq(botUsers.authToken, input.authToken), gt(botUsers.authTokenExpiry, new Date())]
          : []),
      ),
    )
    .returning(BOT_USER_COLUMNS);

  return row ?? null;
}

/**
 * Unbind the Oxy account.
 *
 * `conversation_id` goes too, so the next message starts a fresh conversation
 * rather than continuing one the unlinked account owns.
 */
export async function unlinkBotUser(db: ApiDatabase, id: string): Promise<void> {
  await db
    .update(botUsers)
    .set({
      oxyUserId: null,
      isLinked: false,
      conversationId: null,
      linkedAt: null,
      oxyTaskId: null,
      oxyTaskState: 'reauth_required',
      metadata: sql`${botUsers.metadata} - 'sessionToken'`,
    })
    .where(eq(botUsers.id, id));
}

/** Log a bot user out: unbind, but keep `linked_at` as the historical record. */
export async function logoutBotUser(db: ApiDatabase, id: string): Promise<void> {
  await db
    .update(botUsers)
    .set({
      oxyUserId: null,
      isLinked: false,
      conversationId: null,
      oxyTaskId: null,
      oxyTaskState: 'reauth_required',
      metadata: sql`${botUsers.metadata} - 'sessionToken'`,
    })
    .where(eq(botUsers.id, id));
}

/** Mint a short-lived link token. */
export async function setBotUserAuthToken(
  db: ApiDatabase,
  id: string,
  authToken: string,
  expiry: Date,
): Promise<void> {
  await db.update(botUsers).set({ authToken, authTokenExpiry: expiry }).where(eq(botUsers.id, id));
}

/** Point a bot user at a conversation. `null` detaches it. */
export async function setBotUserConversation(
  db: ApiDatabase,
  id: string,
  conversationId: string | null,
): Promise<void> {
  await db.update(botUsers).set({ conversationId }).where(eq(botUsers.id, id));
}

/** Record the model this person prefers. */
export async function setBotUserPreferredModel(
  db: ApiDatabase,
  id: string,
  preferredModel: string | null,
): Promise<void> {
  await db.update(botUsers).set({ preferredModel }).where(eq(botUsers.id, id));
}

/** Rotate only the still-linked account and task that the caller verified. */
export async function replaceBotUserTask(
  db: ApiDatabase,
  id: string,
  accountId: string,
  expectedTaskId: string | null,
  taskId: string,
): Promise<boolean> {
  const rows = await db
    .update(botUsers)
    .set({
      oxyTaskId: taskId,
      oxyTaskState: 'active',
      metadata: sql`${botUsers.metadata} - 'sessionToken'`,
    })
    .where(
      and(
        eq(botUsers.id, id),
        eq(botUsers.isLinked, true),
        eq(botUsers.oxyUserId, accountId),
        expectedTaskId === null
          ? isNull(botUsers.oxyTaskId)
          : eq(botUsers.oxyTaskId, expectedTaskId),
      ),
    )
    .returning({ id: botUsers.id });
  return rows.length === 1;
}
