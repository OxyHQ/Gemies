#!/usr/bin/env bun
/**
 * `bun run migrate:oxy-files` — copy what Alia stored into Oxy Files, and
 * report where the move stands. `docs/oxy-files.md` is the runbook.
 *
 *   --target-database <name>   REQUIRED: the database this run may touch.
 *   --kind <k>                 library | speech | skills
 *   --apply                    copy; without it nothing is written (preview)
 *   --limit <n>                stop after n items (a canary batch)
 *   --report <path>            write one JSON line per item there (default stdout)
 *   --status                   the bucket-retirement gate: legacy reads per kind
 *                              in the last --window-days (default 14), rows still
 *                              on legacy storage, and the reference outbox backlog
 *   --reconcile [--dry-run]    reconcile every entity type with Oxy now
 *
 * Exit code 0 when every item was copied (or would be), 1 when any failed.
 * Reports carry sha256 hashes, never URLs.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import {
  legacyReadsInWindow,
  referenceSyncBacklog,
  rowsStillOnLegacyStorage,
} from '../db/files/oxyFileRepository.js';
import {
  MIGRATION_KINDS,
  migrateKind,
  type MigrationDeps,
  type MigrationKind,
} from '../lib/files/migrate-to-oxy.js';
import { reconcileReferencesOnce } from '../lib/files/oxy-file-sync.js';

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function writer(path: string | undefined): {
  write: (line: unknown) => void;
  close: () => Promise<void>;
} {
  const stream: WriteStream | null =
    path === undefined ? null : createWriteStream(path, { flags: 'a' });
  return {
    write: (line) => {
      const text = `${JSON.stringify(line)}\n`;
      if (stream === null) process.stdout.write(text);
      else stream.write(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (stream === null) resolve();
        else stream.end(resolve);
      }),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const expectedDatabase = readTargetDatabase(argv);
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);
  const db = getDb();

  try {
    if (argv.includes('--status')) {
      const windowDays = Number(flag(argv, '--window-days') ?? '14');
      const status = {
        windowDays,
        legacyReads: await legacyReadsInWindow(db, windowDays),
        rowsOnLegacyStorage: await rowsStillOnLegacyStorage(db),
        referenceOutbox: await referenceSyncBacklog(db),
      };
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }

    if (argv.includes('--reconcile')) {
      const outcome = await reconcileReferencesOnce(db, {
        force: true,
        dryRun: argv.includes('--dry-run'),
      });
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return 0;
    }

    const kind = flag(argv, '--kind') as MigrationKind | undefined;
    if (kind === undefined || !MIGRATION_KINDS.includes(kind)) {
      throw new Error(`--kind must be one of ${MIGRATION_KINDS.join(', ')}`);
    }
    const apply = argv.includes('--apply');
    const limitFlag = flag(argv, '--limit');
    const deps: MigrationDeps = { db };
    const report = writer(flag(argv, '--report'));
    const counts: Record<string, number> = {};
    try {
      for await (const line of migrateKind(kind, deps, {
        apply,
        ...(limitFlag === undefined ? {} : { limit: Number(limitFlag) }),
      })) {
        counts[line.outcome] = (counts[line.outcome] ?? 0) + 1;
        report.write(line);
      }
    } finally {
      await report.close();
    }

    process.stderr.write(
      `${JSON.stringify({ kind, mode: apply ? 'apply' : 'preview', ...counts })}\n`,
    );
    return (counts.failed ?? 0) > 0 ? 1 : 0;
  } finally {
    await closePostgres();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
