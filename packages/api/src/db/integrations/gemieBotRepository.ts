/**
 * Gemies' own Telegram bots (ADR 0037): rows of `bots` with an `agent_id`.
 *
 * `bot_token` is read by two functions only, which name it: the integrations process's list (it
 * speaks as each bot) and the editor's management calls (it hands the token to that process to
 * set the bot up or stop it). Every other read leaves it out.
 */

import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { bots, type BotGroupReplies, type BotStatus } from '../schema/bots';

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
    const [row] = await tx
      .insert(bots)
      .values({ platform: PLATFORM, status: 'active', ...input })
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
