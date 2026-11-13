/**
 * The synced half of the connectors store, on Postgres (`mcp_catalogue_entries`), and where each
 * registry's sync stands (`mcp_catalogue_sync_state`). Written only by the leader-gated catalogue
 * job (`lib/connector-catalogue/`); read by every request that lists or connects the store.
 */

import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  mcpCatalogueEntries,
  mcpCatalogueSyncState,
  type McpCatalogueAuth,
  type McpCatalogueHealth,
  type McpCatalogueSource,
} from '../schema/integrations';

export type McpCatalogueRow = typeof mcpCatalogueEntries.$inferSelect;
export type NewMcpCatalogueRow = typeof mcpCatalogueEntries.$inferInsert;

/** Every row of one registry, present or removed: what a sync compares a pass against. */
export async function listCatalogueRowsOfSource(
  db: ApiDatabase,
  source: McpCatalogueSource,
): Promise<McpCatalogueRow[]> {
  return db.select().from(mcpCatalogueEntries).where(eq(mcpCatalogueEntries.source, source));
}

const INSERT_BATCH = 500;

export async function insertCatalogueRows(
  db: ApiDatabase,
  rows: readonly NewMcpCatalogueRow[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    await db
      .insert(mcpCatalogueEntries)
      .values(rows.slice(start, start + INSERT_BATCH))
      .onConflictDoNothing();
  }
}

export async function updateCatalogueRow(
  db: ApiDatabase,
  id: string,
  set: Partial<NewMcpCatalogueRow>,
): Promise<void> {
  await db.update(mcpCatalogueEntries).set(set).where(eq(mcpCatalogueEntries.id, id));
}

/** Rows a complete pass no longer listed: removed from the store, kept for their connections. */
export async function markCatalogueRowsRemoved(
  db: ApiDatabase,
  ids: readonly string[],
  now: Date,
): Promise<void> {
  for (let start = 0; start < ids.length; start += INSERT_BATCH) {
    await db
      .update(mcpCatalogueEntries)
      .set({ removedAt: now })
      .where(inArray(mcpCatalogueEntries.id, ids.slice(start, start + INSERT_BATCH)));
  }
}

/**
 * What the store offers from the synced half: present upstream, healthy, and signed in to in a way
 * Gemies supports. Which of these the store shows is then the policy's (`catalogue.ts`).
 */
export async function listOfferedCatalogueRows(db: ApiDatabase): Promise<McpCatalogueRow[]> {
  return db
    .select()
    .from(mcpCatalogueEntries)
    .where(
      and(
        isNull(mcpCatalogueEntries.removedAt),
        eq(mcpCatalogueEntries.health, 'healthy'),
        inArray(mcpCatalogueEntries.auth, ['none', 'oauth']),
      ),
    );
}

/** How long a check is trusted: a healthy server is read again every few days, a failing one less. */
export const HEALTH_RECHECK_MS: Record<McpCatalogueHealth, number> = {
  healthy: 3 * 24 * 60 * 60 * 1000,
  failing: 7 * 24 * 60 * 60 * 1000,
  pending: 24 * 60 * 60 * 1000,
};
/** A check that failed once is repeated this soon, before a second failure counts. */
export const HEALTH_RETRY_MS = 60 * 60 * 1000;

/**
 * The present rows whose health check is due, never-checked first, then the longest unchecked.
 */
export async function listCatalogueRowsDueForCheck(
  db: ApiDatabase,
  now: Date,
  limit: number,
): Promise<McpCatalogueRow[]> {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const checked = mcpCatalogueEntries.healthCheckedAt;
  return (
    db
      .select()
      .from(mcpCatalogueEntries)
      .where(
        and(
          isNull(mcpCatalogueEntries.removedAt),
          or(
            isNull(checked),
            and(
              eq(mcpCatalogueEntries.consecutiveFailures, 1),
              lt(checked, before(HEALTH_RETRY_MS)),
            ),
            and(
              eq(mcpCatalogueEntries.health, 'healthy'),
              lt(checked, before(HEALTH_RECHECK_MS.healthy)),
            ),
            and(
              eq(mcpCatalogueEntries.health, 'failing'),
              lt(checked, before(HEALTH_RECHECK_MS.failing)),
            ),
            and(
              eq(mcpCatalogueEntries.health, 'pending'),
              lt(checked, before(HEALTH_RECHECK_MS.pending)),
            ),
          ),
        ),
      )
      // Never-checked first; among them the best-proven publishers, so a first sync offers the
      // providers' own servers before the rest.
      .orderBy(
        sql`${checked} asc nulls first`,
        sql`case ${mcpCatalogueEntries.trust} when 'official' then 0 when 'verified' then 1 else 2 end`,
        asc(mcpCatalogueEntries.id),
      )
      .limit(limit)
  );
}

export interface CatalogueHealthRecord {
  health: McpCatalogueHealth;
  auth?: McpCatalogueAuth;
  healthMessage: string | null;
  consecutiveFailures: number;
  toolCount?: number | null;
}

export async function recordCatalogueHealth(
  db: ApiDatabase,
  id: string,
  record: CatalogueHealthRecord,
  now: Date,
): Promise<void> {
  await db
    .update(mcpCatalogueEntries)
    .set({ ...record, healthCheckedAt: now })
    .where(eq(mcpCatalogueEntries.id, id));
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

export type McpCatalogueSyncState = typeof mcpCatalogueSyncState.$inferSelect;

export async function getCatalogueSyncState(
  db: ApiDatabase,
  source: McpCatalogueSource,
): Promise<McpCatalogueSyncState | null> {
  const [row] = await db
    .select()
    .from(mcpCatalogueSyncState)
    .where(eq(mcpCatalogueSyncState.source, source))
    .limit(1);
  return row ?? null;
}

export async function recordCatalogueSyncSuccess(
  db: ApiDatabase,
  source: McpCatalogueSource,
  report: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const values = {
    lastSuccessAt: now,
    lastAttemptAt: now,
    retryAfter: null,
    lastError: null,
    lastReport: report,
  };
  await db
    .insert(mcpCatalogueSyncState)
    .values({ source, ...values })
    .onConflictDoUpdate({ target: mcpCatalogueSyncState.source, set: values });
}

export async function recordCatalogueSyncFailure(
  db: ApiDatabase,
  source: McpCatalogueSource,
  error: string,
  retryAfter: Date | null,
  now: Date,
): Promise<void> {
  const values = { lastAttemptAt: now, lastError: error.slice(0, 500), retryAfter };
  await db
    .insert(mcpCatalogueSyncState)
    .values({ source, ...values })
    .onConflictDoUpdate({ target: mcpCatalogueSyncState.source, set: values });
}
