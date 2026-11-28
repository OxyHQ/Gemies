import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { acquireOrRenewLease, releaseLease } from '../coordination/leaseRepository';
import { leases } from '../schema/leases';

/**
 * Leader election through the REPOSITORY, against a real server.
 *
 * `schema.pgdb.test.ts` already asserts these properties against a hand-written
 * statement, which establishes that the TABLE can express them. This file
 * asserts them against the code that actually ships, which is a different claim:
 * a repository emitting a subtly different statement — a missing `setWhere`, an
 * `acquired_at` that resets on every renewal — would leave that suite green and
 * elect two leaders in production.
 *
 * Lease names are namespaced `lease-repo-*` because the pgdb suite shares ONE
 * database across every file and `leases.name` is the primary key; an
 * unqualified `election-1` here would collide with that other file's fixtures.
 */

let db: ApiDatabase;
/**
 * A second, independent connection that plays "the other ECS task" mid-commit:
 * it holds the lease row's lock in an open transaction while the repository runs.
 */
let other: postgres.Sql;

const HOLDER_A = 'task-a';
const HOLDER_B = 'task-b';
const TTL_MS = 60_000;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
  other = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
});

afterAll(async () => {
  await other.end();
  await closePostgres();
});

/**
 * The stored row — read independently of the repository, so a broken write
 * cannot be hidden by the same code that made it.
 *
 * Through the query BUILDER rather than `db.execute`: drizzle's `mode: 'date'`
 * mapping is applied by the result mapper, which raw SQL does not go through, so
 * `db.execute` hands back the driver's `timestamptz` STRING while the column is
 * typed `Date` either way. Every instant assertion below would then be comparing
 * strings and `getTime()` would not exist.
 */
async function readLease(name: string) {
  const [row] = await db.select().from(leases).where(eq(leases.name, name));
  // Throws rather than returning `undefined`: every caller here needs the row,
  // and a missing one is a failed write, not a value to thread through.
  if (!row) throw new Error(`lease '${name}' has no row`);
  return row;
}

/** Make an existing lease look like a dead holder's, WITHOUT waiting out a real TTL. */
function expireLease(name: string) {
  return db.execute(
    sql`update ${leases} set expires_at = now() - interval '1 second' where name = ${name}`,
  );
}

describe('acquiring and renewing', () => {
  it('claims a lease that does not exist yet', async () => {
    const name = 'lease-repo-fresh';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);

    // Positive control: "true" must correspond to a row that is really there.
    // Without this, a repository that returned true and wrote nothing passes.
    const row = await readLease(name);
    expect(row.holderId).toBe(HOLDER_A);
  });

  it('refuses a second instance while the lease is LIVE', async () => {
    const name = 'lease-repo-contended';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);

    // The whole point of the `setWhere`. Drop it and this returns true.
    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(false);

    // And the refusal must be a NO-OP, not a partial write: the incumbent's row
    // is untouched. A `DO UPDATE` without the predicate would have moved
    // `holder_id` here even though the caller was told it lost.
    expect((await readLease(name)).holderId).toBe(HOLDER_A);
  });

  it('lets the SAME instance renew, extending expiry but preserving acquired_at', async () => {
    const name = 'lease-repo-renew';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    const first = await readLease(name);

    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS * 2)).toBe(true);
    const second = await readLease(name);

    // `acquired_at` answers "how long has this task been leader" and must
    // survive a renewal — a `CASE` comparing against the wrong side resets it
    // every heartbeat, which reads as leadership flapping in the logs.
    expect(second.acquiredAt).toEqual(first.acquiredAt);
    // ...while the claim itself really was extended.
    expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
    // `$onUpdate` does not fire inside an insert's conflict clause, so the
    // repository has to set this itself.
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it('lets a successor take over once the holder stops renewing, and RESETS acquired_at', async () => {
    const name = 'lease-repo-takeover';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    const before = await readLease(name);

    await expireLease(name);

    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(true);
    const after = await readLease(name);
    expect(after.holderId).toBe(HOLDER_B);
    // Leadership genuinely changed hands, so this is a NEW tenure.
    expect(after.acquiredAt.getTime()).toBeGreaterThan(before.acquiredAt.getTime());
  });

  it("derives expiry from the SERVER clock, not the caller's", async () => {
    const name = 'lease-repo-clock';
    await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS);
    const row = await readLease(name);

    // Both instants come from the same `now()` in one statement, so the gap is
    // EXACTLY the TTL. A caller-supplied `Date` on either side would make this
    // drift by the client/server clock skew plus a round trip.
    expect(row.expiresAt.getTime() - row.acquiredAt.getTime()).toBe(TTL_MS);
  });
});

describe('releasing', () => {
  it('lets a successor take over immediately', async () => {
    const name = 'lease-repo-release';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    // Before the release, B cannot have it — otherwise the assertion after the
    // release would pass whether or not `releaseLease` did anything at all.
    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(false);

    await releaseLease(db, name, HOLDER_A);

    expect(await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS)).toBe(true);
  });

  it('ignores a release from an instance that no longer holds it', async () => {
    const name = 'lease-repo-stale-release';
    await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS);
    await expireLease(name);
    await acquireOrRenewLease(db, name, HOLDER_B, TTL_MS);

    // A slow shutdown on the OLD holder must not hand B's live lease away.
    await releaseLease(db, name, HOLDER_A);

    const row = await readLease(name);
    expect(row.holderId).toBe(HOLDER_B);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

/**
 * Resolves with the promise's value, or rejects once `ms` passes: the way to
 * assert "this did NOT wait for that lock" without hanging the suite when it does.
 */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms).unref?.();
    }),
  ]);
}

/**
 * Starts a transaction on `other` that renews `name` for `holder` and stays OPEN
 * (the row lock held) until the returned `finish` commits or rolls it back. This
 * is what a holder's renewal looks like to everyone else while its COMMIT waits
 * on a synchronous standby.
 */
async function holdRenewalOpen(name: string, holder: string) {
  let finish!: (outcome: 'commit' | 'rollback') => void;
  const decided = new Promise<'commit' | 'rollback'>((resolve) => {
    finish = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = other
    .begin(async (tx) => {
      await tx`update leases set holder_id = ${holder}, expires_at = now() + interval '1 minute' where name = ${name}`;
      locked();
      if ((await decided) === 'rollback') throw new Error('rollback');
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback') throw error;
    });
  await isLocked;
  return {
    async commit() {
      finish('commit');
      await done;
    },
    async rollback() {
      finish('rollback');
      await done;
    },
  };
}

describe('row locks (the measured 43 s stalls)', () => {
  it("does not wait on a LIVE holder's in-flight renewal when it cannot win", async () => {
    const name = 'lease-repo-no-wait';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);

    const renewal = await holdRenewalOpen(name, HOLDER_A);
    try {
      // The old INSERT ... ON CONFLICT DO UPDATE locked the row before its WHERE
      // and sat here until the holder's transaction ended.
      expect(await within(2_000, acquireOrRenewLease(db, name, HOLDER_B, TTL_MS))).toBe(false);
    } finally {
      await renewal.commit();
    }
    expect((await readLease(name)).holderId).toBe(HOLDER_A);
  });

  it('a contender for a LAPSED lease waits for the in-flight renewal and loses when it commits', async () => {
    const name = 'lease-repo-lapsed-commit';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    await expireLease(name);

    const renewal = await holdRenewalOpen(name, HOLDER_A);
    const contender = acquireOrRenewLease(db, name, HOLDER_B, TTL_MS);
    // It MAY win, so it must wait for the lock and then re-check the predicate
    // against the renewed row instead of the expired one it first saw.
    await expect(within(300, contender)).rejects.toThrow('still waiting');
    await renewal.commit();
    expect(await contender).toBe(false);
    expect((await readLease(name)).holderId).toBe(HOLDER_A);
  });

  it('a contender for a LAPSED lease takes it when the in-flight renewal rolls back', async () => {
    const name = 'lease-repo-lapsed-rollback';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    await expireLease(name);

    const renewal = await holdRenewalOpen(name, HOLDER_A);
    const contender = acquireOrRenewLease(db, name, HOLDER_B, TTL_MS);
    await renewal.rollback();
    expect(await contender).toBe(true);
    expect((await readLease(name)).holderId).toBe(HOLDER_B);
  });

  it('renews, not refuses, when its own first claim is still uncommitted', async () => {
    const name = 'lease-repo-own-first-insert';
    // This instance's first heartbeat, inserted but not committed when the
    // next heartbeat (same holder) runs and sees no row in its snapshot.
    let finish!: () => void;
    const decided = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let inserted!: () => void;
    const isInserted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const first = other.begin(async (tx) => {
      await tx`insert into leases (name, holder_id, expires_at, acquired_at) values (${name}, ${HOLDER_A}, now() + interval '1 minute', date_trunc('milliseconds', now()))`;
      inserted();
      await decided;
    });
    await isInserted;
    const second = acquireOrRenewLease(db, name, HOLDER_A, TTL_MS);
    await expect(within(300, second)).rejects.toThrow('still waiting');
    finish();
    await first;
    expect(await second).toBe(true);
    expect((await readLease(name)).holderId).toBe(HOLDER_A);
  });

  it('elects exactly one of several instances racing for a lease with no row yet', async () => {
    const name = 'lease-repo-first-boot-race';
    const holders = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'];
    const results = await Promise.all(
      holders.map((holder) => acquireOrRenewLease(db, name, holder, TTL_MS)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readLease(name)).holderId).toBe(holders[results.indexOf(true)]);
  });

  it('elects exactly one of several instances racing for a lapsed lease', async () => {
    const name = 'lease-repo-lapsed-race';
    expect(await acquireOrRenewLease(db, name, HOLDER_A, TTL_MS)).toBe(true);
    await expireLease(name);
    const holders = ['task-6', 'task-7', 'task-8', 'task-9', 'task-10'];
    const results = await Promise.all(
      holders.map((holder) => acquireOrRenewLease(db, name, holder, TTL_MS)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readLease(name)).holderId).toBe(holders[results.indexOf(true)]);
  });
});
