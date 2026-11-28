/**
 * Leader-election leases, on Postgres.
 *
 * One statement does the work, and the shape of its RESULT is the answer:
 * `acquireOrRenewLease` returns a row when this instance holds the lease and no
 * row when another instance holds a live one. There is no second read deciding
 * afterwards, because a second read is a second instant — and two ECS tasks
 * racing at that seam is the only failure this table exists to prevent.
 *
 * ## Why an `UPDATE` first, and an `INSERT` only for a missing row
 *
 * The claim is `holderId == me OR expiresAt < now()`, evaluated server-side, in
 * ONE statement: a writable CTE that UPDATEs the row when the predicate holds and
 * INSERTs it only when no row exists yet (first boot). It is not "select, then
 * decide in JavaScript": that is two instants, and two ECS tasks racing at that
 * seam is exactly what this table exists to prevent.
 *
 * It used to be `INSERT … ON CONFLICT DO UPDATE … WHERE`, which elects the same
 * winner but LOCKS the conflicting row before it evaluates the `WHERE`, so the
 * instance that loses still takes the row lock. Every task heartbeats every lease
 * on the same 20 s cadence from the same deploy, so the loser routinely queued
 * behind the holder's renewal and waited for its COMMIT, which on a primary with
 * quorum-synchronous replicas includes the standby round trip and stalls for as
 * long as replication does. Measured on PlanetScale (2026-11-28, ~10 h): 9,600
 * calls, 431 s of statement time, mean 45 ms, stddev 1.1 s, max 43 s, for a
 * one-row write whose neighbours in the same database take 0.2 ms.
 *
 * A plain `UPDATE` evaluates its `WHERE` on the committed row version BEFORE it
 * tries to lock it. A loser looking at a live lease held by someone else skips the
 * row without locking or waiting; only an instance that may actually win (the
 * holder renewing, or a contender for an expired lease) takes the lock, and READ
 * COMMITTED re-checks the predicate on the newest version after any wait
 * (EvalPlanQual), so two contenders for a lapsed lease still produce one winner.
 *
 * The `INSERT` runs only when the statement's snapshot has no row at all
 * (a lease name's first boot). If another statement inserted the row meanwhile,
 * its conflict clause is the previous upsert, unchanged: renew if the row is
 * mine (this instance's own earlier heartbeat whose insert had not committed
 * yet), take it if it lapsed, otherwise nothing. So two first-boot instances
 * still produce one holder, and an instance never reads its own uncommitted
 * first claim as somebody else's. The UPDATE and the INSERT can never both act,
 * because one needs the row to exist in the snapshot and the other needs it not
 * to.
 *
 * Either way the shape of the RESULT is the answer: a row when this instance
 * holds the lease, no row when another instance holds a live one. A failure still
 * propagates as an exception, so "not the leader" and "the database is
 * unreachable" stay distinguishable. Collapsing them is how a network blip turns
 * into two leaders.
 *
 * ## The clock is the SERVER's, always
 *
 * Every instant here is `now()` evaluated by Postgres. Nothing binds a JavaScript
 * `Date`, and nothing compares against one. Two ECS tasks whose clocks disagree
 * by more than the lease TTL would otherwise both believe they hold it, which is
 * precisely the thing being prevented — and a bound `Date` would also be the
 * caller's clock wearing the server's authority.
 *
 * Stored instants are truncated to millisecond precision to match `@oxy.so/db`'s
 * `createdAt`/`updatedAt` defaults; a `timestamptz` carries microseconds a JS
 * `Date` cannot hold, so an untruncated write does not survive the round trip.
 * The expiry PREDICATE compares against a bare `now()` — it is a comparison, not
 * a stored value, and sub-millisecond precision there is free.
 */

import { sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { leases } from '../schema/leases';

/** `now()` at the precision a JavaScript `Date` can hold — see the module comment. */
const serverNow = sql`date_trunc('milliseconds', now())`;

/**
 * Claim `name` for `holderId`, or renew it if this instance already holds it.
 *
 * @returns `true` when this instance holds the lease afterwards, `false` when
 *   another instance holds a live one. Throws if the database cannot be reached
 *   — never conflated with `false`.
 */
export async function acquireOrRenewLease(
  db: ApiDatabase,
  name: string,
  holderId: string,
  leaseTtlMs: number,
): Promise<boolean> {
  const expiresAt = sql`${serverNow} + (${leaseTtlMs} * interval '1 millisecond')`;

  /**
   * `acquired_at` is preserved across renewals by the SAME holder and reset only
   * when leadership changes hands: in an UPDATE's SET list the column is the
   * row's CURRENT value, so the `case` reads the stored holder. `updated_at` is
   * set explicitly because `$onUpdate` belongs to `db.update()`, not raw SQL.
   * The `where` is the whole election: mine already, or the claim has lapsed.
   */
  const rows = await db.execute<{ holder_id: string }>(sql`
    with renewed as (
      update ${leases}
      set holder_id = ${holderId},
          expires_at = ${expiresAt},
          acquired_at = case when ${leases.holderId} = ${holderId} then ${leases.acquiredAt} else ${serverNow} end,
          updated_at = ${serverNow}
      where ${leases.name} = ${name}
        and (${leases.holderId} = ${holderId} or ${leases.expiresAt} < now())
      returning ${leases.holderId}
    ),
    created as (
      insert into ${leases} (name, holder_id, expires_at, acquired_at)
      select ${name}, ${holderId}, ${expiresAt}, ${serverNow}
      where not exists (select 1 from ${leases} where ${leases.name} = ${name})
      on conflict (name) do update
        set holder_id = ${holderId},
            expires_at = ${expiresAt},
            acquired_at = case when ${leases.holderId} = ${holderId} then ${leases.acquiredAt} else ${serverNow} end,
            updated_at = ${serverNow}
        where ${leases.holderId} = ${holderId} or ${leases.expiresAt} < now()
      returning ${leases.holderId}
    )
    select holder_id from renewed
    union all
    select holder_id from created
  `);

  return rows.length > 0;
}

/**
 * Give up `name` if this instance holds it, so a successor can take over
 * immediately instead of waiting out the remaining TTL.
 *
 * Expiring the row rather than deleting it keeps `acquired_at` readable for the
 * next holder to overwrite and keeps the primary key stable, which is what makes
 * the acquire statement above an UPDATE rather than a race between two inserts.
 *
 * The `holder_id` predicate is what stops a shutting-down instance releasing a
 * lease another instance has already taken over.
 */
export async function releaseLease(db: ApiDatabase, name: string, holderId: string): Promise<void> {
  await db
    .update(leases)
    .set({ expiresAt: sql`'epoch'::timestamptz` })
    .where(sql`${leases.name} = ${name} and ${leases.holderId} = ${holderId}`);
}
