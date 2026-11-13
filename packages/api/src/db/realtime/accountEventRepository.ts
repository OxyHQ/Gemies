/**
 * The per-account event log (`db/schema/realtime.ts`, `docs/realtime.mdx`).
 *
 * Append is ONE statement: the head row's update and the event's insert, so the head's row lock
 * lives exactly as long as the append and numbers commit in order. Callers never pass a
 * transaction: an event describes a change that has ALREADY committed, and appending it inside
 * that change's transaction would hold the account's head lock for the whole of it.
 */

import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { AccountEventType } from '../../domain/account-events.js';
import type { ApiDatabase } from '../index';
import { accountEventHeads, accountEvents } from '../schema/realtime';

export interface StoredAccountEvent {
  readonly seq: number;
  readonly type: AccountEventType;
  readonly data: unknown;
  readonly createdAt: Date;
}

/** Append one event to an account's log and return it with its number. */
export async function appendAccountEvent(
  db: ApiDatabase,
  oxyUserId: string,
  type: AccountEventType,
  data: unknown,
): Promise<StoredAccountEvent> {
  const rows = await db.execute<{ seq: string | number; created_at: string | Date }>(sql`
    with head as (
      insert into ${accountEventHeads} (oxy_user_id, seq)
      values (${oxyUserId}, 1)
      on conflict (oxy_user_id) do update set seq = ${accountEventHeads}.seq + 1
      returning seq
    )
    insert into ${accountEvents} (id, oxy_user_id, seq, type, data)
    select gen_random_uuid()::text, ${oxyUserId}, head.seq, ${type}, ${JSON.stringify(data)}::jsonb
    from head
    returning seq, created_at
  `);
  const row = rows[0];
  if (!row) throw new Error('account event append returned no row');
  return { seq: Number(row.seq), type, data, createdAt: new Date(row.created_at) };
}

/** The account's newest event number; 0 for an account that has none. */
export async function accountEventHead(db: ApiDatabase, oxyUserId: string): Promise<number> {
  const [row] = await db
    .select({ seq: accountEventHeads.seq })
    .from(accountEventHeads)
    .where(eq(accountEventHeads.oxyUserId, oxyUserId));
  return row?.seq ?? 0;
}

/**
 * What a client that applied `since` missed: `events` in order, or `gap` when the log no longer
 * reaches back to `since + 1` (swept, or more than `limit` behind) and the client must reload.
 */
export async function accountEventsSince(
  db: ApiDatabase,
  oxyUserId: string,
  since: number,
  limit: number,
): Promise<{ head: number; events: StoredAccountEvent[]; gap: boolean }> {
  const head = await accountEventHead(db, oxyUserId);
  if (since >= head) return { head, events: [], gap: since > head };
  if (head - since > limit) return { head, events: [], gap: true };
  const rows = await db
    .select({
      seq: accountEvents.seq,
      type: accountEvents.type,
      data: accountEvents.data,
      createdAt: accountEvents.createdAt,
    })
    .from(accountEvents)
    .where(and(eq(accountEvents.oxyUserId, oxyUserId), gt(accountEvents.seq, since)))
    .orderBy(asc(accountEvents.seq))
    .limit(limit);
  // The first event after `since` must still be there; a swept one means the client is too far behind.
  const gap = rows.length === 0 || rows[0]?.seq !== since + 1;
  return {
    head,
    events: gap ? [] : rows.map((row) => ({ ...row, type: row.type as AccountEventType })),
    gap,
  };
}
