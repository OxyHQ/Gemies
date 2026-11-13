/**
 * Keeping the store's synced half in step with the official MCP Registry.
 *
 * One pass reads the whole registry (`official-registry.ts`), keeps the servers the policy accepts
 * (`policy.ts`), leaves out listing farms (a publisher with more servers than anyone runs by hand),
 * drops those the curated catalogue already offers (`lib/mcp-registry.ts`: same
 * endpoint or same registry name; a synced server never overrides a curated one) and keeps one
 * listing per endpoint. Then, against what is stored:
 *
 * - a new server is inserted `pending`: it is offered only once its health check passes;
 * - a changed one is updated, and checked again; a new endpoint is `pending` again;
 * - one the pass no longer lists is marked removed (and comes back if it is listed again).
 *
 * A pass that fails, or is rate limited, changes nothing: a server missing from a partial pass is not
 * a removed one. The counts, refusals by reason included, are kept in `mcp_catalogue_sync_state`.
 */

import type { ApiDatabase } from '../../db/index.js';
import {
  getCatalogueSyncState,
  insertCatalogueRows,
  listCatalogueRowsOfSource,
  markCatalogueRowsRemoved,
  type McpCatalogueRow,
  type NewMcpCatalogueRow,
  recordCatalogueSyncFailure,
  recordCatalogueSyncSuccess,
  updateCatalogueRow,
} from '../../db/integrations/mcpCatalogueRepository.js';
import { log } from '../logger.js';
import { MCP_REGISTRY, type McpRegistryEntry } from '../mcp-registry.js';
import {
  RegistryRateLimitError,
  readOfficialRegistry,
  type RegistryPass,
} from './official-registry.js';
import {
  CATALOGUE_OVERRIDES,
  type CandidateRefusal,
  type CatalogueCandidate,
  type CatalogueOverride,
  candidateFromRegistry,
  catalogueOverride,
  endpointKey,
  MAX_SERVERS_PER_PUBLISHER,
  preferredListing,
  publisherOf,
} from './policy.js';

const SOURCE = 'mcp_registry' as const;

export interface CatalogueSyncReport {
  listed: number;
  candidates: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Listed servers not taken, by why. */
  refused: Partial<Record<CandidateRefusal | 'curated' | 'duplicate' | 'malformed', number>>;
}

export type CatalogueSyncOutcome =
  | { status: 'synced'; report: CatalogueSyncReport }
  | { status: 'deferred'; until: Date }
  | { status: 'failed'; error: string; retryAt: Date | null };

export interface CatalogueSyncOptions {
  read?: () => Promise<RegistryPass>;
  curated?: readonly McpRegistryEntry[];
  overrides?: Readonly<Record<string, CatalogueOverride>>;
  now?: Date;
}

/** The fields a pass owns; the rest (health, auth, timestamps) belong to the job's other steps. */
function listingOf(candidate: CatalogueCandidate) {
  const { id: _id, ...listing } = candidate;
  return listing;
}

function sameListing(row: McpCatalogueRow, candidate: CatalogueCandidate): boolean {
  const listing = listingOf(candidate);
  return (Object.keys(listing) as (keyof typeof listing)[]).every((key) => {
    const value = listing[key];
    const stored = row[key];
    if (value instanceof Date || stored instanceof Date) {
      return (value as Date | null)?.getTime() === (stored as Date | null)?.getTime();
    }
    return JSON.stringify(value) === JSON.stringify(stored);
  });
}

function bump(report: CatalogueSyncReport, reason: keyof CatalogueSyncReport['refused'], by = 1) {
  report.refused[reason] = (report.refused[reason] ?? 0) + by;
}

/**
 * The pass's candidates: without listing farms (a publisher past `MAX_SERVERS_PER_PUBLISHER`),
 * without what the curated catalogue offers, and one per endpoint.
 */
export function selectCandidates(
  pass: RegistryPass,
  curated: readonly McpRegistryEntry[],
  overrides: Readonly<Record<string, CatalogueOverride>>,
  report: CatalogueSyncReport,
): CatalogueCandidate[] {
  const curatedEndpoints = new Set(curated.map((entry) => endpointKey(entry.url)));
  const curatedNames = new Set(curated.flatMap((entry) => entry.mcpRegistryName ?? []));
  if (pass.malformed) bump(report, 'malformed', pass.malformed);

  const read: CatalogueCandidate[] = [];
  const perPublisher = new Map<string, number>();
  for (const listed of pass.servers) {
    const candidate = candidateFromRegistry(listed, overrides);
    if (!candidate.ok) {
      bump(report, candidate.reason);
      continue;
    }
    const publisher = publisherOf(candidate.candidate.upstreamName);
    perPublisher.set(publisher, (perPublisher.get(publisher) ?? 0) + 1);
    read.push(candidate.candidate);
  }

  const byEndpoint = new Map<string, CatalogueCandidate>();
  for (const candidate of read) {
    if (
      (perPublisher.get(publisherOf(candidate.upstreamName)) ?? 0) > MAX_SERVERS_PER_PUBLISHER &&
      !catalogueOverride(candidate.upstreamName, candidate.url, overrides)?.allowBulk
    ) {
      bump(report, 'bulk_publisher');
      continue;
    }
    const key = endpointKey(candidate.url);
    if (curatedEndpoints.has(key) || curatedNames.has(candidate.upstreamName)) {
      bump(report, 'curated');
      continue;
    }
    const kept = byEndpoint.get(key);
    if (kept) bump(report, 'duplicate');
    byEndpoint.set(key, kept ? preferredListing(kept, candidate) : candidate);
  }
  return [...byEndpoint.values()];
}

/** One sync of the official MCP Registry. Never throws: a failure is its outcome. */
export async function syncConnectorCatalogue(
  db: ApiDatabase,
  {
    read = () => readOfficialRegistry(),
    curated = MCP_REGISTRY,
    overrides = CATALOGUE_OVERRIDES,
    now = new Date(),
  }: CatalogueSyncOptions = {},
): Promise<CatalogueSyncOutcome> {
  const state = await getCatalogueSyncState(db, SOURCE);
  if (state?.retryAfter && state.retryAfter > now) {
    return { status: 'deferred', until: state.retryAfter };
  }

  let pass: RegistryPass;
  try {
    pass = await read();
  } catch (err: unknown) {
    const retryAt = err instanceof RegistryRateLimitError ? err.retryAt : null;
    const error = err instanceof Error ? err.message : String(err);
    await recordCatalogueSyncFailure(db, SOURCE, error, retryAt, now);
    log.general.warn({ err, retryAt }, 'MCP Registry sync failed');
    return { status: 'failed', error, retryAt };
  }

  const report: CatalogueSyncReport = {
    listed: pass.servers.length + pass.malformed,
    candidates: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    refused: {},
  };
  const candidates = selectCandidates(pass, curated, overrides, report);
  report.candidates = candidates.length;

  const stored = new Map(
    (await listCatalogueRowsOfSource(db, SOURCE)).map((row) => [row.id, row] as const),
  );
  const inserts: NewMcpCatalogueRow[] = [];
  for (const candidate of candidates) {
    const row = stored.get(candidate.id);
    stored.delete(candidate.id);
    if (!row) {
      inserts.push({ ...candidate, source: SOURCE, firstSeenAt: now });
      report.created += 1;
      continue;
    }
    if (sameListing(row, candidate) && row.removedAt === null) {
      report.unchanged += 1;
      continue;
    }
    const moved = row.url !== candidate.url || row.transport !== candidate.transport;
    await updateCatalogueRow(db, row.id, {
      ...listingOf(candidate),
      removedAt: null,
      // Another endpoint is another server until it is checked; a new version of the same one
      // stays offered and is checked again on the next round.
      healthCheckedAt: null,
      ...(moved
        ? { health: 'pending', auth: 'unknown', consecutiveFailures: 0, toolCount: null }
        : {}),
    });
    report.updated += 1;
  }
  await insertCatalogueRows(db, inserts);

  const gone = [...stored.values()].filter((row) => row.removedAt === null).map((row) => row.id);
  await markCatalogueRowsRemoved(db, gone, now);
  report.removed = gone.length;

  await recordCatalogueSyncSuccess(db, SOURCE, { ...report }, now);
  log.general.info({ report }, 'MCP Registry synced');
  return { status: 'synced', report };
}
