/**
 * Gemies' own Telegram bots (ADR 0037): rows of `bots` with an `agent_id`.
 *
 * `bot_token` is read by two functions only, which name it: the integrations process's list (it
 * speaks as each bot) and the editor's management calls (it hands the token to that process to
 * set the bot up or stop it). Every other read leaves it out.
 */

import { and, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import { decrypt } from '../../lib/crypto-utils.js';
import type { ApiDatabase } from '../index';
import { bots, gemieBotTurns, type BotGroupReplies, type BotStatus } from '../schema/bots';

type Executor = Pick<ApiDatabase, 'select' | 'insert' | 'update' | 'delete'>;

const PLATFORM = 'telegram';

export interface GemieBotRow {
  id: string;
  /** Telegram's id for the bot. */
  botId: string;
  agentId: string;
  /** The person who connected it: who pays when the gemie cannot, and alone says whether. */
  userId: string;
  name: string;
  username: string | null;
  status: BotStatus;
  groupReplies: BotGroupReplies;
  ownerPaysAgentTurns: boolean;
  /** `userId`'s Telegram account, once they proved it with the editor's link; `null` before. */
  linkedTelegramUserId: string | null;
  /** The Oxy task `userId` granted the gemie for their own turns here; `null` before they link. */
  oxyTaskId: string | null;
  totalMessages: number;
  lastMessageAt: Date | null;
  /** The last failure to give the bot its gemie's profile, while it is still behind; else null. */
  profileSyncError: string | null;
  createdAt: Date;
}

const COLUMNS = {
  id: bots.id,
  botId: bots.botId,
  agentId: bots.agentId,
  userId: bots.userId,
  name: bots.name,
  username: bots.username,
  status: bots.status,
  groupReplies: bots.groupReplies,
  ownerPaysAgentTurns: bots.ownerPaysAgentTurns,
  linkedTelegramUserId: bots.linkedTelegramUserId,
  oxyTaskId: bots.oxyTaskId,
  totalMessages: bots.totalMessages,
  lastMessageAt: bots.lastMessageAt,
  profileSyncError: bots.profileSyncError,
  createdAt: bots.createdAt,
} as const;

type Selected = { [K in keyof typeof COLUMNS]: unknown };

/** A gemie bot row has an agent and an owner by construction; the columns are nullable for system bots. */
function asGemieBot(row: Selected): GemieBotRow {
  return row as GemieBotRow;
}

const isGemieBot = and(
  eq(bots.platform, PLATFORM),
  isNotNull(bots.agentId),
  isNotNull(bots.userId),
);

/** A gemie's bot, without its token. */
export async function findGemieBot(db: Executor, agentId: string): Promise<GemieBotRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(bots)
    .where(and(isGemieBot, eq(bots.agentId, agentId)))
    .limit(1);
  return row ? asGemieBot(row) : null;
}

/** A gemie's bot with its token: for the calls that hand it to the integrations process. */
export async function findGemieBotToken(db: Executor, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ botToken: bots.botToken })
    .from(bots)
    .where(and(isGemieBot, eq(bots.agentId, agentId)))
    .limit(1);
  return row?.botToken ?? null;
}

/** The active gemie bot Telegram knows by `botId`, without its token. */
export async function findActiveGemieBotByTelegramId(
  db: Executor,
  botId: string,
): Promise<GemieBotRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(bots)
    .where(and(isGemieBot, eq(bots.botId, botId), eq(bots.status, 'active')))
    .limit(1);
  return row ? asGemieBot(row) : null;
}

/** An active gemie bot's gemie and token, by Telegram's id for it: to write in one of its chats. */
export async function findActiveGemieBotTokenByTelegramId(
  db: Executor,
  botId: string,
): Promise<{ agentId: string; token: string } | null> {
  const [row] = await db
    .select({ agentId: bots.agentId, token: bots.botToken })
    .from(bots)
    .where(and(isGemieBot, eq(bots.botId, botId), eq(bots.status, 'active')))
    .limit(1);
  return row?.agentId && row.token ? { agentId: row.agentId, token: row.token } : null;
}

/** Every active gemie bot with its token and @username: what the integrations process speaks as. */
export async function listActiveGemieBotsWithTokens(
  db: Executor,
): Promise<Array<{ botId: string; token: string; username: string }>> {
  const rows = await db
    .select({ botId: bots.botId, token: bots.botToken, username: bots.username })
    .from(bots)
    .where(and(isGemieBot, eq(bots.status, 'active')));
  return rows.flatMap((row) =>
    row.token && row.username
      ? [{ botId: row.botId, token: row.token, username: row.username }]
      : [],
  );
}

/** Whether a Telegram bot is already some OTHER gemie's. */
export async function telegramBotTakenByAnother(
  db: Executor,
  botId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ agentId: bots.agentId })
    .from(bots)
    .where(and(eq(bots.platform, PLATFORM), eq(bots.botId, botId)))
    .limit(1);
  return row !== undefined && row.agentId !== agentId;
}

/**
 * Make a Telegram bot the gemie's: its first, or a new one replacing the one it had. The person
 * saving it becomes the one who pays when the gemie cannot, with the consent they gave now. A bot it
 * replaces takes its person's link with it: `released` is the Oxy task that link held, for the
 * caller to revoke.
 */
export async function saveGemieBot(
  db: ApiDatabase,
  input: {
    agentId: string;
    userId: string;
    botId: string;
    name: string;
    username: string;
    botToken: string;
    ownerPaysAgentTurns: boolean;
  },
): Promise<{ bot: GemieBotRow; released: string | null }> {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .delete(bots)
      .where(and(isGemieBot, eq(bots.agentId, input.agentId)))
      .returning({ oxyTaskId: bots.oxyTaskId });
    // A new bot is behind its gemie until the first sync gives it the gemie's profile.
    const [row] = await tx
      .insert(bots)
      .values({
        platform: PLATFORM,
        status: 'active',
        ...input,
        profileDirtyAt: new Date(),
        profileSyncAfter: new Date(),
      })
      .returning(COLUMNS);
    if (!row) throw new Error('The gemie bot was not saved');
    return { bot: asGemieBot(row), released: previous?.oxyTaskId ?? null };
  });
}

/** The bot's settings; `ownerPaysAgentTurns` only by the person who connected it. */
export async function setGemieBotSettings(
  db: Executor,
  agentId: string,
  patch: { groupReplies?: BotGroupReplies; name?: string; username?: string },
): Promise<GemieBotRow | null> {
  const [row] = await db
    .update(bots)
    .set(patch)
    .where(and(isGemieBot, eq(bots.agentId, agentId)))
    .returning(COLUMNS);
  return row ? asGemieBot(row) : null;
}

export async function setGemieBotOwnerPays(
  db: Executor,
  agentId: string,
  userId: string,
  ownerPaysAgentTurns: boolean,
): Promise<GemieBotRow | null> {
  const [row] = await db
    .update(bots)
    .set({ ownerPaysAgentTurns })
    .where(and(isGemieBot, eq(bots.agentId, agentId), eq(bots.userId, userId)))
    .returning(COLUMNS);
  return row ? asGemieBot(row) : null;
}

/** Forget a gemie's bot; the Oxy task its person's link held, for the caller to revoke. */
export async function deleteGemieBot(db: Executor, agentId: string): Promise<string | null> {
  const [row] = await db
    .delete(bots)
    .where(and(isGemieBot, eq(bots.agentId, agentId)))
    .returning({ oxyTaskId: bots.oxyTaskId });
  return row?.oxyTaskId ?? null;
}

/**
 * A new one-time link for the bot's person (`userId`, and only them), with the Oxy task they grant
 * the gemie for their turns there. `replaced` is a task the bot held before, for the caller to
 * revoke; `null` when the row is not theirs (nothing is written then).
 */
export async function setGemieBotLinkCode(
  db: Executor,
  input: {
    agentId: string;
    userId: string;
    codeHash: string;
    expiresAt: Date;
    oxyTaskId: string;
  },
): Promise<{ bot: GemieBotRow; replaced: string | null } | null> {
  const [before] = await db
    .select({ oxyTaskId: bots.oxyTaskId })
    .from(bots)
    .where(and(isGemieBot, eq(bots.agentId, input.agentId), eq(bots.userId, input.userId)))
    .limit(1);
  if (!before) return null;
  const [row] = await db
    .update(bots)
    .set({
      linkCodeHash: input.codeHash,
      linkCodeExpiresAt: input.expiresAt,
      oxyTaskId: input.oxyTaskId,
    })
    .where(and(isGemieBot, eq(bots.agentId, input.agentId), eq(bots.userId, input.userId)))
    .returning(COLUMNS);
  if (!row) return null;
  return {
    bot: asGemieBot(row),
    replaced: before.oxyTaskId && before.oxyTaskId !== input.oxyTaskId ? before.oxyTaskId : null,
  };
}

/**
 * Redeem a bot's one-time link: the Telegram account that opened it becomes its person's. Once,
 * before it expires, on that bot only; `null` for any other code.
 */
export async function claimGemieBotLinkCode(
  db: Executor,
  input: { botId: string; codeHash: string; telegramUserId: string; now?: Date },
): Promise<GemieBotRow | null> {
  const [row] = await db
    .update(bots)
    .set({
      linkedTelegramUserId: input.telegramUserId,
      linkCodeHash: null,
      linkCodeExpiresAt: null,
    })
    .where(
      and(
        isGemieBot,
        eq(bots.botId, input.botId),
        eq(bots.status, 'active'),
        eq(bots.linkCodeHash, input.codeHash),
        gt(bots.linkCodeExpiresAt, input.now ?? new Date()),
      ),
    )
    .returning(COLUMNS);
  return row ? asGemieBot(row) : null;
}

/** The bot's person unlinks their Telegram: the task it held, for the caller to revoke. */
export async function unlinkGemieBotPerson(
  db: Executor,
  agentId: string,
  userId: string,
): Promise<{ bot: GemieBotRow; released: string | null } | null> {
  const [before] = await db
    .select({ oxyTaskId: bots.oxyTaskId })
    .from(bots)
    .where(and(isGemieBot, eq(bots.agentId, agentId), eq(bots.userId, userId)))
    .limit(1);
  if (!before) return null;
  const [row] = await db
    .update(bots)
    .set({
      linkedTelegramUserId: null,
      linkCodeHash: null,
      linkCodeExpiresAt: null,
      oxyTaskId: null,
    })
    .where(and(isGemieBot, eq(bots.agentId, agentId), eq(bots.userId, userId)))
    .returning(COLUMNS);
  return row ? { bot: asGemieBot(row), released: before.oxyTaskId } : null;
}

/** One more answered message. */
export async function recordGemieBotMessage(db: Executor, id: string): Promise<void> {
  await db
    .update(bots)
    .set({ totalMessages: sql`${bots.totalMessages} + 1`, lastMessageAt: new Date() })
    .where(eq(bots.id, id));
}

// ---------------------------------------------------------------------------
// The bot's profile follows its gemie (`lib/gemie-telegram-bot-profile.ts`)
// ---------------------------------------------------------------------------

/**
 * The gemie changed: its bot is behind until the next sync, which waits `debounceMs` so a burst of
 * edits (an editor autosaving as someone types) becomes one. A new change resets the attempts.
 * True when the gemie has a bot.
 */
export async function markGemieBotProfileBehind(
  db: Executor,
  agentId: string,
  debounceMs: number,
): Promise<boolean> {
  const rows = await db
    .update(bots)
    .set({
      profileDirtyAt: new Date(),
      profileSyncAfter: new Date(Date.now() + debounceMs),
      profileSyncAttempts: 0,
    })
    .where(and(isGemieBot, eq(bots.agentId, agentId)))
    .returning({ id: bots.id });
  return rows.length > 0;
}

/** A bot whose profile is due, claimed for one attempt. */
export interface ClaimedProfileSync {
  id: string;
  agentId: string;
  token: string;
  /** When the gemie last changed, as claimed: a sync settles only that change. */
  dirtyAt: Date;
  attempts: number;
  photoKey: string | null;
}

/**
 * Claim the next bot whose profile is due, holding it for `leaseMs` so no other instance (or a
 * second tick) takes it meanwhile; a claim that dies with its instance is due again after it.
 */
/** A bot whose token cannot be read is looked at again after this long. */
const UNREADABLE_RETRY_MS = 6 * 60 * 60_000;

export async function claimDueGemieBotProfile(
  db: ApiDatabase,
  leaseMs: number,
): Promise<ClaimedProfileSync | 'unreadable' | null> {
  return db.transaction(async (tx) => {
    const [due] = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(
        and(
          isGemieBot,
          eq(bots.status, 'active'),
          isNotNull(bots.profileDirtyAt),
          lte(bots.profileSyncAfter, new Date()),
        ),
      )
      .orderBy(bots.profileSyncAfter)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!due) return null;
    const [row] = await tx
      .update(bots)
      .set({ profileSyncAfter: new Date(Date.now() + leaseMs) })
      .where(eq(bots.id, due.id))
      .returning({
        id: bots.id,
        agentId: bots.agentId,
        // Read as stored and decrypted here, so one token that cannot be read never stops the rest.
        sealedToken: sql<string | null>`${bots.botToken}`,
        dirtyAt: bots.profileDirtyAt,
        attempts: bots.profileSyncAttempts,
        photoKey: bots.profilePhotoKey,
      });
    if (!row?.agentId || !row.sealedToken || !row.dirtyAt) return null;
    let token: string;
    try {
      token = decrypt(row.sealedToken);
    } catch {
      await tx
        .update(bots)
        .set({
          profileSyncError: 'The bot’s token cannot be read; connect the bot again',
          profileSyncAfter: new Date(Date.now() + UNREADABLE_RETRY_MS),
        })
        .where(eq(bots.id, row.id));
      return 'unreadable';
    }
    return {
      id: row.id,
      agentId: row.agentId,
      token,
      dirtyAt: row.dirtyAt,
      attempts: row.attempts,
      photoKey: row.photoKey,
    };
  });
}

/**
 * The bot shows its gemie as of the claim. It is up to date unless the gemie changed again while
 * it synced; then that newer change is due after `debounceMs`.
 */
export async function settleGemieBotProfile(
  db: Executor,
  claim: ClaimedProfileSync,
  photoKey: string | null,
  debounceMs: number,
): Promise<void> {
  const unchanged = eq(bots.profileDirtyAt, claim.dirtyAt);
  await db
    .update(bots)
    .set({
      profilePhotoKey: photoKey,
      profileSyncError: null,
      profileSyncAttempts: 0,
      profileDirtyAt: sql`case when ${unchanged} then null else ${bots.profileDirtyAt} end`,
      profileSyncAfter: sql`case when ${unchanged} then null else ${new Date(Date.now() + debounceMs).toISOString()}::timestamptz end`,
    })
    .where(eq(bots.id, claim.id));
}

/** The attempt failed: said to the editor, and tried again at `retryAt`. */
export async function deferGemieBotProfile(
  db: Executor,
  claim: ClaimedProfileSync,
  input: { error: string; retryAt: Date; photoKey: string | null },
): Promise<void> {
  await db
    .update(bots)
    .set({
      profileSyncError: input.error,
      profileSyncAttempts: claim.attempts + 1,
      profileSyncAfter: input.retryAt,
      profilePhotoKey: input.photoKey,
    })
    .where(eq(bots.id, claim.id));
}

/** One Telegram message of a gemie's bot. */
export interface GemieBotTurnKey {
  readonly botId: string;
  readonly chatId: string;
  readonly messageId: string;
}

/** What claiming a message's turn found. */
export type GemieBotTurnClaim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'running' }
  | { readonly kind: 'answered'; readonly answer: Record<string, unknown> };

const turnKey = (key: GemieBotTurnKey) =>
  and(
    eq(gemieBotTurns.botId, key.botId),
    eq(gemieBotTurns.chatId, key.chatId),
    eq(gemieBotTurns.messageId, key.messageId),
  );

/**
 * Take a message's turn: `claimed` when this attempt runs it (the first, or one taking over a
 * claim older than `leaseMs`, whose instance died), else what the earlier attempt left.
 */
export async function claimGemieBotTurn(
  db: ApiDatabase,
  key: GemieBotTurnKey,
  leaseMs: number,
): Promise<GemieBotTurnClaim> {
  const inserted = await db
    .insert(gemieBotTurns)
    .values({ ...key, status: 'running' })
    .onConflictDoNothing()
    .returning({ botId: gemieBotTurns.botId });
  if (inserted.length > 0) return { kind: 'claimed' };
  const takenOver = await db
    .update(gemieBotTurns)
    .set({ updatedAt: new Date() })
    .where(
      and(
        turnKey(key),
        eq(gemieBotTurns.status, 'running'),
        lte(gemieBotTurns.updatedAt, new Date(Date.now() - leaseMs)),
      ),
    )
    .returning({ botId: gemieBotTurns.botId });
  if (takenOver.length > 0) return { kind: 'claimed' };
  return readGemieBotTurn(db, key);
}

/** What a message's turn is now. */
export async function readGemieBotTurn(
  db: ApiDatabase,
  key: GemieBotTurnKey,
): Promise<GemieBotTurnClaim> {
  const [row] = await db
    .select({ status: gemieBotTurns.status, answer: gemieBotTurns.answer })
    .from(gemieBotTurns)
    .where(turnKey(key));
  return row?.status === 'answered' && row.answer
    ? { kind: 'answered', answer: row.answer }
    : { kind: 'running' };
}

/** The turn answered: every later attempt gets this answer. */
export async function settleGemieBotTurn(
  db: ApiDatabase,
  key: GemieBotTurnKey,
  answer: Record<string, unknown>,
): Promise<void> {
  await db
    .update(gemieBotTurns)
    .set({ status: 'answered', answer, updatedAt: new Date() })
    .where(turnKey(key));
}

/** Forget turns older than `maxAgeMs`: no retry reaches them any more. */
export async function pruneGemieBotTurns(db: ApiDatabase, maxAgeMs: number): Promise<number> {
  const removed = await db
    .delete(gemieBotTurns)
    .where(lte(gemieBotTurns.createdAt, new Date(Date.now() - maxAgeMs)))
    .returning({ botId: gemieBotTurns.botId });
  return removed.length;
}
