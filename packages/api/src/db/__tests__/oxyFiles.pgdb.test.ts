import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, uuidv7 } from '@oxy.so/db';
import type { OxyServer } from '@oxy.so/core/server';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  claimReconcileRun,
  claimReferenceSyncs,
  completeReferenceSync,
  countLegacyRead,
  dueGarbageCandidates,
  failReferenceSync,
  isFileEventHandled,
  claimFileEvent,
  isLegacyObjectReferenced,
  legacyReadsInWindow,
  markLegacyObjectsMaybeGarbage,
  recordFileReferences,
  ReferenceOutsideTransactionError,
  referenceInventory,
} from '../files/oxyFileRepository';
import {
  oxyFileReconcileRuns,
  oxyFileReferenceSync,
  storageGcCandidates,
} from '../schema/oxy-files';
import { libraryFiles } from '../schema/library';
import { skillFiles } from '../schema/skills';
import { speechClips } from '../schema/speech';
import { createLibraryFile, deleteLibraryFile } from '../library/libraryFileRepository';
import { RELEASE_ONLY_OXY_FILE_ENTITY_TYPES } from '../../domain/oxy-files';
import { createSkill, deleteOwnedSkill, insertSkillVersion } from '../agents/skillRepository';
import {
  collectLegacyGarbageOnce,
  drainReferenceSyncOnce,
  setOxyFileSyncClientForTests,
} from '../../lib/files/oxy-file-sync';

/**
 * Alia's Oxy Files bookkeeping against a real Postgres (oxy ADR 0043): the
 * reference outbox and its claim, the storage CHECKs, the transactional
 * reference writes of every row that names a file, the legacy garbage
 * collector, the legacy-read gate and the event dedupe.
 *
 * Every id here is this file's own (`RUN`), so parallel files never see — or
 * sweep — these rows.
 */

let db: ApiDatabase;
const RUN = `oxyfiles-${uuidv7()}`;
const USER = `${RUN}-user`;

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  setOxyFileSyncClientForTests(null);
  await db
    .delete(oxyFileReferenceSync)
    .where(sql`${oxyFileReferenceSync.fileId} like ${`${RUN}%`}`);
  await db.delete(storageGcCandidates).where(sql`${storageGcCandidates.key} like ${`${RUN}%`}`);
  await closePostgres();
});

const intentsFor = (fileId: string) =>
  db
    .select({
      entityId: oxyFileReferenceSync.entityId,
      desired: oxyFileReferenceSync.desired,
      generation: oxyFileReferenceSync.generation,
    })
    .from(oxyFileReferenceSync)
    .where(eq(oxyFileReferenceSync.fileId, fileId));

async function expectCheck(promise: Promise<unknown>, constraint: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isCheckViolation(error)).toBe(true);
  expect(constraintNameOf(error)).toBe(constraint);
}

describe('the reference outbox', () => {
  it('refuses to be written outside a transaction', async () => {
    await expect(
      recordFileReferences(db, [
        { fileId: `${RUN}-f0`, entityType: 'library_file', entityId: 'e', desired: 'present' },
      ]),
    ).rejects.toBeInstanceOf(ReferenceOutsideTransactionError);
  });

  it('keeps one desired state per (file, entity), bumping the generation on every change', async () => {
    const file = `${RUN}-f1`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'library_file', entityId: 's1', desired: 'present' },
      ]),
    );
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'library_file', entityId: 's1', desired: 'absent' },
      ]),
    );
    expect(await intentsFor(file)).toEqual([{ entityId: 's1', desired: 'absent', generation: 2 }]);
  });

  it('a worker never deletes an intent rewritten while it held the claim', async () => {
    const file = `${RUN}-f2`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'library_file', entityId: 'l1', desired: 'present' },
      ]),
    );
    const owner = `${RUN}-worker`;
    const claimed = (
      await claimReferenceSyncs(db, { leaseOwner: owner, limit: 1000, leaseSeconds: 60 })
    ).filter((row) => row.fileId === file);
    expect(claimed).toHaveLength(1);
    // A second claimer sees nothing while the lease is live.
    const again = await claimReferenceSyncs(db, {
      leaseOwner: `${owner}-2`,
      limit: 1000,
      leaseSeconds: 60,
    });
    expect(again.some((row) => row.fileId === file)).toBe(false);

    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'library_file', entityId: 'l1', desired: 'absent' },
      ]),
    );
    expect(await completeReferenceSync(db, claimed[0]!, owner)).toBe(false);
    expect(await intentsFor(file)).toEqual([{ entityId: 'l1', desired: 'absent', generation: 2 }]);
  });

  it('backs off a failure and dead-letters it after the last attempt', async () => {
    const file = `${RUN}-f3`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'skill_file', entityId: 'k1', desired: 'present' },
      ]),
    );
    const owner = `${RUN}-failer`;
    const [row] = (
      await claimReferenceSyncs(db, { leaseOwner: owner, limit: 1000, leaseSeconds: 60 })
    ).filter((claimed) => claimed.fileId === file);
    await failReferenceSync(db, row!, owner, 'Oxy said 503', 1);
    const [stored] = await db
      .select({ status: oxyFileReferenceSync.status, lastError: oxyFileReferenceSync.lastError })
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.fileId, file));
    expect(stored).toEqual({ status: 'dead_letter', lastError: 'Oxy said 503' });
  });

  it('drains present and absent intents into references.add / remove, and forgets them', async () => {
    const file = `${RUN}-f4`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'library_file', entityId: 'a', desired: 'present' },
        { fileId: file, entityType: 'library_file', entityId: 'b', desired: 'absent' },
      ]),
    );
    const calls: { method: string; references: { entityId: string }[] }[] = [];
    const answer =
      (method: string, result: string) =>
      async (references: { fileId: string; entityType: string; entityId: string }[]) => {
        calls.push({ method, references });
        return references.map((reference) => ({ ...reference, result }));
      };
    setOxyFileSyncClientForTests(
      () =>
        ({
          assets: {
            references: { add: answer('add', 'created'), remove: answer('remove', 'removed') },
          },
        }) as unknown as OxyServer,
    );
    // Other files' rows may be due too; drain until this file's are gone.
    for (let pass = 0; pass < 20 && (await intentsFor(file)).length > 0; pass += 1) {
      await drainReferenceSyncOnce(db);
    }
    expect(await intentsFor(file)).toEqual([]);
    expect(
      calls.some(
        (call) => call.method === 'add' && call.references.some((r) => r.entityId === 'a'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.method === 'remove' && call.references.some((r) => r.entityId === 'b'),
      ),
    ).toBe(true);
  });

  it('still delivers the release of an entity class Alia no longer uses, and nothing else of it', async () => {
    const [released] = RELEASE_ONLY_OXY_FILE_ENTITY_TYPES;
    const file = `${RUN}-f5`;
    // What a migration that retires an entity class leaves in the outbox: its
    // releases, written in SQL, since no code may record one any more.
    await db
      .insert(oxyFileReferenceSync)
      .values({ fileId: file, entityType: released, entityId: 'retired-1', desired: 'absent' });
    type Reference = { fileId: string; entityType: string; entityId: string };
    const sent: { method: string; reference: Reference }[] = [];
    // Other files' rows may be due too, and are answered like any Oxy would.
    const answer = (method: string, result: string) => async (references: Reference[]) => {
      for (const reference of references) sent.push({ method, reference });
      return references.map((reference) => ({ ...reference, result }));
    };
    setOxyFileSyncClientForTests(
      () =>
        ({
          assets: {
            references: { add: answer('add', 'created'), remove: answer('remove', 'removed') },
          },
        }) as unknown as OxyServer,
    );
    for (let pass = 0; pass < 20 && (await intentsFor(file)).length > 0; pass += 1) {
      await drainReferenceSyncOnce(db);
    }
    expect(await intentsFor(file)).toEqual([]);
    expect(sent.filter(({ reference }) => reference.fileId === file)).toEqual([
      {
        method: 'remove',
        reference: { fileId: file, entityType: released, entityId: 'retired-1' },
      },
    ]);
    // The nightly reconciliation no longer knows it: its ledger refuses the class.
    await expectCheck(
      db.insert(oxyFileReconcileRuns).values({ entityType: released as never }),
      'oxy_file_reconcile_runs_entity_type_check',
    );
  });

  it('the retiring migration never lets its release overtake an add still in flight', async () => {
    const [released] = RELEASE_ONLY_OXY_FILE_ENTITY_TYPES;
    const file = `${RUN}-f6`;
    await db
      .insert(oxyFileReferenceSync)
      .values({ fileId: file, entityType: released, entityId: 'in-flight', desired: 'present' });
    // Worker A holds the `present` intent: its `references.add` is on the wire.
    const owner = `${RUN}-adder`;
    const [held] = (
      await claimReferenceSyncs(db, { leaseOwner: owner, limit: 1000, leaseSeconds: 60 })
    ).filter((row) => row.fileId === file);
    if (held === undefined) throw new Error('worker A claimed nothing');

    // Migration 0170's own UPDATE, read from the file the migrator applies.
    const migration = readFileSync(
      new URL('../../../drizzle/0170_podcasts_belong_to_syra.sql', import.meta.url),
      'utf8',
    );
    const update = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^\s*(--[^\n]*\n)*/u, '').trim())
      .find((statement) => statement.startsWith('UPDATE "oxy_file_reference_sync"'));
    expect(update).toBeDefined();
    await db.execute(sql.raw(update ?? ''));

    const [row] = await db
      .select({
        desired: oxyFileReferenceSync.desired,
        leaseOwner: oxyFileReferenceSync.leaseOwner,
        generation: oxyFileReferenceSync.generation,
      })
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.fileId, file));
    // Now a release, still under A's lease, one generation on.
    expect(row).toEqual({ desired: 'absent', leaseOwner: owner, generation: held.generation + 1 });
    // So no other worker can send the release while A's add is outstanding…
    const overtaking = await claimReferenceSyncs(db, {
      leaseOwner: `${RUN}-remover`,
      limit: 1000,
      leaseSeconds: 60,
    });
    expect(overtaking.some((claimed) => claimed.fileId === file)).toBe(false);
    // …and A, when its add returns, can neither forget nor fail the release.
    expect(await completeReferenceSync(db, held, owner)).toBe(false);
    await failReferenceSync(db, held, owner, 'late', 1);
    expect(await intentsFor(file)).toEqual([
      { entityId: 'in-flight', desired: 'absent', generation: held.generation + 1 },
    ]);
  });
});

describe('rows that name a stored file', () => {
  it('a library file names a legacy object or an Oxy file, never neither', async () => {
    await expectCheck(
      db.insert(libraryFiles).values({
        ownerOxyUserId: USER,
        name: 'x',
        url: null,
        oxyFileId: null,
        type: 'application/pdf',
        size: 1,
        category: 'documents',
      }),
      'library_files_storage_check',
    );
  });

  it('a spoken clip names a legacy object or an Oxy file, never neither', async () => {
    await expectCheck(
      db.insert(speechClips).values({ cacheKey: `${RUN}-clip`, oxyUserId: USER, objectKey: null }),
      'speech_clips_storage_check',
    );
  });

  it('a skill file is inline XOR stored, and stored may be legacy, Oxy, or both', async () => {
    const skill = await db.transaction((tx) =>
      createSkill(tx, {
        name: `${RUN}-skill`,
        displayName: 'S',
        description: 'd',
        source: 'authored',
        ownerOxyUserId: USER,
      }),
    );
    const version = await db.transaction((tx) =>
      insertSkillVersion(
        tx,
        { skillId: skill._id, body: 'b', frontmatter: {}, checksum: 'c', bytes: 1 },
        [
          {
            path: 'a.bin',
            kind: 'asset',
            mime: 'application/zip',
            bytes: 1,
            sha256: 's',
            oxyFileId: `${RUN}-sf1`,
          },
          {
            path: 'b.bin',
            kind: 'asset',
            mime: 'application/zip',
            bytes: 1,
            sha256: 's',
            s3Key: `${RUN}/skills/b`,
            oxyFileId: `${RUN}-sf2`,
          },
        ],
      ),
    );
    // The version's Oxy files were referenced with the version.
    expect(await intentsFor(`${RUN}-sf1`)).toEqual([
      expect.objectContaining({ desired: 'present' }),
    ]);
    await expectCheck(
      db.insert(skillFiles).values({
        versionId: version._id,
        path: 'c.txt',
        kind: 'reference',
        mime: 'text/plain',
        bytes: 1,
        sha256: 's',
        contentText: 'inline',
        oxyFileId: `${RUN}-sf3`,
      }),
      'skill_files_storage_check',
    );

    // Deleting the skill releases every stored file of every version.
    expect(await deleteOwnedSkill(db, skill._id, USER)).toBe(1);
    expect(await intentsFor(`${RUN}-sf1`)).toEqual([
      expect.objectContaining({ desired: 'absent' }),
    ]);
    const candidates = await db
      .select({ key: storageGcCandidates.key, kind: storageGcCandidates.kind })
      .from(storageGcCandidates)
      .where(eq(storageGcCandidates.key, `${RUN}/skills/b`));
    expect(candidates).toEqual([{ key: `${RUN}/skills/b`, kind: 'skill_file' }]);
  });

  it('deleting a library file releases what it named in the same transaction', async () => {
    const legacy = await createLibraryFile(db, {
      ownerOxyUserId: USER,
      name: 'a.pdf',
      url: `${RUN}/library/a.pdf`,
      type: 'application/pdf',
      size: 3,
      category: 'documents',
    });
    const moved = await createLibraryFile(db, {
      ownerOxyUserId: USER,
      name: 'b.pdf',
      url: null,
      oxyFileId: `${RUN}-lib-b`,
      type: 'application/pdf',
      size: 3,
      category: 'documents',
    });
    expect(await intentsFor(`${RUN}-lib-b`)).toEqual([
      expect.objectContaining({ desired: 'present' }),
    ]);

    expect(await deleteLibraryFile(db, legacy.id, USER)).toBe(1);
    expect(await deleteLibraryFile(db, moved.id, USER)).toBe(1);
    expect(await intentsFor(`${RUN}-lib-b`)).toEqual([
      expect.objectContaining({ desired: 'absent' }),
    ]);
    const due = await dueGarbageCandidates(db, 10_000);
    expect(due.some((candidate) => candidate.key === `${RUN}/library/a.pdf`)).toBe(true);
  });
});

describe('the legacy garbage collector', () => {
  it('deletes only what no row names, once the grace has passed', async () => {
    const used = `${RUN}/gc/used.mp3`;
    const orphan = `${RUN}/gc/orphan.mp3`;
    const fresh = `${RUN}/gc/fresh.mp3`;
    await db
      .insert(speechClips)
      .values({ cacheKey: `${RUN}-used`, oxyUserId: USER, objectKey: used });
    await markLegacyObjectsMaybeGarbage(
      db,
      [
        { key: used, kind: 'speech_clip' },
        { key: orphan, kind: 'speech_clip' },
      ],
      0,
    );
    await markLegacyObjectsMaybeGarbage(db, [{ key: fresh, kind: 'speech_clip' }], 3600);
    expect(await isLegacyObjectReferenced(db, 'speech_clip', used)).toBe(true);
    expect(await isLegacyObjectReferenced(db, 'speech_clip', orphan)).toBe(false);

    const deleted: string[] = [];
    // Other files' candidates may be due; this run's are asserted by key.
    await collectLegacyGarbageOnce(db, async (keys) => {
      deleted.push(...keys);
      return keys.length;
    });
    expect(deleted).toContain(orphan);
    expect(deleted).not.toContain(used);
    expect(deleted).not.toContain(fresh);
    const left = await db
      .select({ key: storageGcCandidates.key })
      .from(storageGcCandidates)
      .where(inArray(storageGcCandidates.key, [used, orphan, fresh]));
    expect(left).toEqual([{ key: fresh }]);
  });

  it('a re-upload pushes the deadline forward, never back', async () => {
    const key = `${RUN}/gc/again.mp3`;
    await markLegacyObjectsMaybeGarbage(db, [{ key, kind: 'speech_clip' }], 3600);
    await markLegacyObjectsMaybeGarbage(db, [{ key, kind: 'speech_clip' }], 0);
    const due = await dueGarbageCandidates(db, 10_000);
    expect(due.some((candidate) => candidate.key === key)).toBe(false);
  });
});

describe('the gate and the ledgers', () => {
  it('counts legacy reads per kind per day', async () => {
    const before = (await legacyReadsInWindow(db, 1)).audio_job ?? 0;
    await countLegacyRead(db, 'audio_job');
    await countLegacyRead(db, 'audio_job');
    expect((await legacyReadsInWindow(db, 1)).audio_job).toBeGreaterThanOrEqual(before + 2);
  });

  it('streams a reference inventory in keyset pages', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const id = `${RUN}-inv-${n}`;
      ids.push(id);
      await db
        .insert(speechClips)
        .values({ cacheKey: id, oxyUserId: USER, oxyFileId: `${RUN}-invf-${n}` });
    }
    const seen: string[] = [];
    for await (const item of referenceInventory(db, 'speech_clip')) {
      if (item.entityId.startsWith(`${RUN}-inv-`)) seen.push(`${item.entityId}:${item.fileId}`);
    }
    expect(seen).toEqual(ids.map((id, n) => `${id}:${RUN}-invf-${n}`));
  });

  it('a reconciliation is claimed once per interval', async () => {
    // The shared row: claim it twice in a row; the second must lose.
    await db.execute(
      sql`update oxy_file_reconcile_runs set last_started_at = null where entity_type = 'speech_clip'`,
    );
    expect(await claimReconcileRun(db, 'speech_clip', 24)).toBe(true);
    expect(await claimReconcileRun(db, 'speech_clip', 24)).toBe(false);
  });

  it('remembers an event only once', async () => {
    const event = { id: `${RUN}-evt`, type: 'file.deleted', fileId: 'f' };
    expect(await isFileEventHandled(db, event.id)).toBe(false);
    expect(await claimFileEvent(db, event)).toBe(true);
    expect(await claimFileEvent(db, event)).toBe(false);
    expect(await isFileEventHandled(db, event.id)).toBe(true);
  });
});
