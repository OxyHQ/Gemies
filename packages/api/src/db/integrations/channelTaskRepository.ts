/**
 * Every channel's Oxy task, across the three tables that hold one (`lib/channel-task-authority.ts`):
 *
 *  - `account`: a person's connected account (`connected_accounts`), while a gemie answers it — the
 *    task's actor is that gemie (ADR 0035 as amended);
 *  - `bot_link`: a person's link to a system bot (`bot_users`, Discord), answered by their own
 *    assistant;
 *  - `gemie_bot`: the person who connected a gemie's own Telegram bot, once they linked their
 *    Telegram to it (`bots`, ADR 0037 amendment) — the gemie is the actor.
 *
 * Only a LIVE binding is listed: one whose channel still delivers to it (a connected session, a
 * linked person, an active bot), since only that one needs its task. Each table's own writes stay
 * in its repository; this one reads them alike, lapses them alike and claims their notices alike.
 */

import { and, eq, inArray, isNotNull, isNull, lte, or, type SQL } from 'drizzle-orm';
import { botConversationId } from '../../domain/gemie-bot-person';
import type { ChannelTaskHold } from '../../domain/channel-task';
import type { OxyTask } from '../../lib/oxy-task-authority';
import type { ApiDatabase } from '../index';
import { bots, botUsers } from '../schema/bots';
import { connectedAccountGrants, connectedAccounts } from '../schema/integrations';
import { setConnectedAccountTask } from './connectedAccountRepository';
import { replaceBotUserTask } from './botRepository';
import { replaceGemieBotTask } from './gemieBotRepository';

export const CHANNEL_KINDS = ['account', 'bot_link', 'gemie_bot'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface ChannelBindingRef {
  readonly kind: ChannelKind;
  /** The row's own id: the account's, the bot user's, or the gemie bot's. */
  readonly id: string;
}

/** A live binding and the task it holds. */
export interface ChannelBinding extends ChannelBindingRef, ChannelTaskHold {
  /** The person whose authority the task is. */
  readonly personAccountId: string;
  readonly platform: string;
  /** The gemie the task names as its actor; `null` for a system bot link (the person's assistant). */
  readonly gemieId: string | null;
  /**
   * Where the channel itself reaches the person, when it does: the system bot's chat, or the gemie
   * bot's private conversation with them (`telegram:<bot>:<chat>`). `null` for an account, whose
   * gateway finds them (`notifyAccountPerson`).
   */
  readonly personChat: string | null;
}

/** The live bindings of each kind, narrowed by `where` of that kind's own table. */
async function liveAccounts(db: ApiDatabase, where?: SQL): Promise<ChannelBinding[]> {
  const rows = await db
    .select({
      id: connectedAccounts.id,
      personAccountId: connectedAccounts.oxyUserId,
      platform: connectedAccounts.platform,
      gemieId: connectedAccountGrants.agentId,
      oxyTaskId: connectedAccounts.oxyTaskId,
      oxyTaskState: connectedAccounts.oxyTaskState,
      oxyTaskExpiresAt: connectedAccounts.oxyTaskExpiresAt,
    })
    .from(connectedAccounts)
    // Only an account a gemie answers holds a task: its actor is that gemie.
    .innerJoin(
      connectedAccountGrants,
      and(
        eq(connectedAccountGrants.accountId, connectedAccounts.id),
        eq(connectedAccountGrants.answers, true),
      ),
    )
    .where(
      and(eq(connectedAccounts.status, 'connected'), isNotNull(connectedAccounts.sessionId), where),
    );
  return rows.map((row) => ({ ...row, kind: 'account', personChat: null }));
}

async function liveBotLinks(db: ApiDatabase, where?: SQL): Promise<ChannelBinding[]> {
  const rows = await db
    .select({
      id: botUsers.id,
      personAccountId: botUsers.oxyUserId,
      platform: botUsers.platform,
      personChat: botUsers.chatId,
      oxyTaskId: botUsers.oxyTaskId,
      oxyTaskState: botUsers.oxyTaskState,
      oxyTaskExpiresAt: botUsers.oxyTaskExpiresAt,
    })
    .from(botUsers)
    .innerJoin(bots, eq(bots.id, botUsers.botId))
    .where(
      and(
        eq(botUsers.isLinked, true),
        isNotNull(botUsers.oxyUserId),
        eq(bots.status, 'active'),
        // A system bot: a gemie's own bot links its person on its own row (`liveGemieBots`).
        isNull(bots.userId),
        where,
      ),
    );
  return rows.flatMap((row) =>
    row.personAccountId
      ? [{ ...row, personAccountId: row.personAccountId, kind: 'bot_link', gemieId: null }]
      : [],
  );
}

async function liveGemieBots(db: ApiDatabase, where?: SQL): Promise<ChannelBinding[]> {
  const rows = await db
    .select({
      id: bots.id,
      personAccountId: bots.userId,
      platform: bots.platform,
      gemieId: bots.agentId,
      botId: bots.botId,
      linkedTelegramUserId: bots.linkedTelegramUserId,
      oxyTaskId: bots.oxyTaskId,
      oxyTaskState: bots.oxyTaskState,
      oxyTaskExpiresAt: bots.oxyTaskExpiresAt,
    })
    .from(bots)
    .where(
      and(
        eq(bots.platform, 'telegram'),
        isNotNull(bots.agentId),
        isNotNull(bots.userId),
        eq(bots.status, 'active'),
        isNotNull(bots.linkedTelegramUserId),
        where,
      ),
    );
  return rows.flatMap(({ botId, linkedTelegramUserId, ...row }) =>
    row.personAccountId && row.gemieId && linkedTelegramUserId
      ? [
          {
            ...row,
            personAccountId: row.personAccountId,
            kind: 'gemie_bot',
            personChat: botConversationId({ botId }, linkedTelegramUserId),
          },
        ]
      : [],
  );
}

/** Every live channel binding of one person. */
export async function listPersonChannelBindings(
  db: ApiDatabase,
  personAccountId: string,
): Promise<ChannelBinding[]> {
  const [accounts, links, gemieBots] = await Promise.all([
    liveAccounts(db, eq(connectedAccounts.oxyUserId, personAccountId)),
    liveBotLinks(db, eq(botUsers.oxyUserId, personAccountId)),
    liveGemieBots(db, eq(bots.userId, personAccountId)),
  ]);
  return [...accounts, ...links, ...gemieBots];
}

/**
 * Put a freshly minted task in the binding's place, only while it still holds the task it was read
 * with. False when it changed meanwhile (nothing is written then).
 */
export async function bindChannelTask(
  db: ApiDatabase,
  binding: ChannelBinding,
  task: OxyTask,
): Promise<boolean> {
  switch (binding.kind) {
    case 'account':
      return setConnectedAccountTask(db, binding.id, task, binding.oxyTaskId);
    case 'bot_link':
      return replaceBotUserTask(db, binding.id, binding.personAccountId, binding.oxyTaskId, task);
    case 'gemie_bot':
      return binding.gemieId
        ? replaceGemieBotTask(db, {
            agentId: binding.gemieId,
            userId: binding.personAccountId,
            expectedTaskId: binding.oxyTaskId,
            task,
          })
        : false;
  }
}

const TABLES = [connectedAccounts, botUsers, bots] as const;

/** Mark `reauth_required` every active task `where` picks, in all three tables; how many. */
async function lapse(
  db: ApiDatabase,
  where: (table: (typeof TABLES)[number]) => SQL | undefined,
): Promise<number> {
  const counts = await Promise.all(
    TABLES.map(async (table) => {
      const rows = await db
        .update(table)
        .set({ oxyTaskState: 'reauth_required' })
        .where(and(eq(table.oxyTaskState, 'active'), where(table)))
        .returning({ id: table.id });
      return rows.length;
    }),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

/** Every task past the expiry Oxy gave it is dead: its binding needs its person. */
export function lapseExpiredChannelTasks(db: ApiDatabase, now: Date): Promise<number> {
  return lapse(db, (table) => lte(table.oxyTaskExpiresAt, now));
}

/** Oxy refused this task (revoked, expired, or no longer honoured): whoever holds it needs them. */
export function lapseRefusedChannelTask(db: ApiDatabase, taskId: string): Promise<number> {
  return lapse(db, (table) => eq(table.oxyTaskId, taskId));
}

/**
 * Claim, at most `limit` per kind, the live bindings whose person has to be told, and has not
 * been: their task is dead (`reauth_required`) or lapses by `noticeBefore`. The claim is the
 * `oxy_task_notified_at` written here, one conditional statement per table, so of instances
 * sweeping together only one claims each; a new task clears it.
 */
export async function claimChannelTaskNotices(
  db: ApiDatabase,
  input: { now: Date; noticeBefore: Date; limit: number },
): Promise<ChannelBinding[]> {
  const due = (table: (typeof TABLES)[number]) =>
    and(
      isNull(table.oxyTaskNotifiedAt),
      or(
        eq(table.oxyTaskState, 'reauth_required'),
        lte(table.oxyTaskExpiresAt, input.noticeBefore),
      ),
    );
  const claim = async (
    table: (typeof TABLES)[number],
    candidates: readonly ChannelBinding[],
  ): Promise<Set<string>> => {
    const ids = candidates.slice(0, input.limit).map((binding) => binding.id);
    if (ids.length === 0) return new Set();
    const rows = await db
      .update(table)
      .set({ oxyTaskNotifiedAt: input.now })
      .where(and(inArray(table.id, ids), due(table)))
      .returning({ id: table.id });
    return new Set(rows.map((row) => row.id));
  };
  const [accounts, links, gemieBots] = await Promise.all([
    liveAccounts(db, due(connectedAccounts)),
    liveBotLinks(db, due(botUsers)),
    liveGemieBots(db, due(bots)),
  ]);
  const [claimedAccounts, claimedLinks, claimedBots] = await Promise.all([
    claim(connectedAccounts, accounts),
    claim(botUsers, links),
    claim(bots, gemieBots),
  ]);
  return [
    ...accounts.filter((binding) => claimedAccounts.has(binding.id)),
    ...links.filter((binding) => claimedLinks.has(binding.id)),
    ...gemieBots.filter((binding) => claimedBots.has(binding.id)),
  ];
}

/** A notice that could not be delivered is claimed again by the next sweep. */
export async function releaseChannelTaskNotice(
  db: ApiDatabase,
  binding: ChannelBindingRef,
): Promise<void> {
  const table = { account: connectedAccounts, bot_link: botUsers, gemie_bot: bots }[binding.kind];
  await db.update(table).set({ oxyTaskNotifiedAt: null }).where(eq(table.id, binding.id));
}
