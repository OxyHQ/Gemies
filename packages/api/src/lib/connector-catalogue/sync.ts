/**
 * Keeping the store's synced half in step with its sources, one at a time (`CATALOGUE_SOURCES`): the
 * official MCP Registry, the primary one, then Docker's MCP catalogue.
 *
 * One pass reads a whole catalogue, keeps the servers the policy accepts (`policy.ts`), leaves out
 * listing farms (a publisher with more servers than anyone runs by hand), drops those the curated
 * catalogue already offers (`lib/mcp-registry.ts`: same endpoint or same registry name; a synced
 * server never overrides a curated one) and those an earlier source already lists (the same
 * endpoint), and keeps one listing per endpoint. Then, against what is stored:
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
import type { McpCatalogueSource } from '../../db/schema/integrations.js';
import { readDockerCatalogue } from './docker-catalogue.js';
import { readOfficialRegistry } from './official-registry.js';
import {
  CATALOGUE_OVERRIDES,
  type CandidateRefusal,
  type CatalogueCandidate,
  type CatalogueOverride,
  type CataloguePass,
  CatalogueRateLimitError,
  candidateOf,
  catalogueOverride,
  endpointKey,
  MAX_SERVERS_PER_PUBLISHER,
  preferredListing,
} from './policy.js';

/** The sources, the primary first: a later source never takes an endpoint an earlier one lists. */
export const CATALOGUE_SOURCES: readonly {
  source: McpCatalogueSource;
  label: string;
  read: () => Promise<CataloguePass>;
}[] = [
  { source: 'mcp_registry', label: 'MCP Registry', read: () => readOfficialRegistry() },
  { source: 'docker', label: "Docker's MCP catalogue", read: () => readDockerCatalogue() },
];

export interface CatalogueSyncReport {
  listed: number;
  candidates: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Listed servers not taken, by why. */
  refused: Partial<
    Record<CandidateRefusal | 'curated' | 'earlier_source' | 'duplicate' | 'malformed', number>
  >;
}

export type CatalogueSyncOutcome =
  | { status: 'synced'; report: CatalogueSyncReport }
  | { status: 'deferred'; until: Date }
  | { status: 'failed'; error: string; retryAt: Date | null };

export interface CatalogueSyncOptions {
  source?: McpCatalogueSource;
  read?: () => Promise<CataloguePass>;
  curated?: readonly McpRegistryEntry[];
  /** Endpoints an earlier source already lists (`endpointKey`), not taken from this one. */
  earlierEndpoints?: ReadonlySet<string>;
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
 * without what the curated catalogue or an earlier source offers, and one per endpoint.
 */
export function selectCandidates(
  pass: CataloguePass,
  curated: readonly McpRegistryEntry[],
  overrides: Readonly<Record<string, CatalogueOverride>>,
  report: CatalogueSyncReport,
  earlierEndpoints: ReadonlySet<string> = new Set(),
): CatalogueCandidate[] {
  const curatedEndpoints = new Set(curated.map((entry) => endpointKey(entry.url)));
  const curatedNames = new Set(curated.flatMap((entry) => entry.mcpRegistryName ?? []));
  if (pass.malformed) bump(report, 'malformed', pass.malformed);

  const read: { candidate: CatalogueCandidate; publisher: string | null }[] = [];
  const perPublisher = new Map<string, number>();
  for (const listed of pass.servers) {
    const candidate = candidateOf(listed, overrides);
    if (!candidate.ok) {
      bump(report, candidate.reason);
      continue;
    }
    if (listed.publisher) {
      perPublisher.set(listed.publisher, (perPublisher.get(listed.publisher) ?? 0) + 1);
    }
    read.push({ candidate: candidate.candidate, publisher: listed.publisher });
  }

  const byEndpoint = new Map<string, CatalogueCandidate>();
  for (const { candidate, publisher } of read) {
    if (
      publisher &&
      (perPublisher.get(publisher) ?? 0) > MAX_SERVERS_PER_PUBLISHER &&
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
    if (earlierEndpoints.has(key)) {
      bump(report, 'earlier_source');
      continue;
    }
    const kept = byEndpoint.get(key);
    if (kept) bump(report, 'duplicate');
    byEndpoint.set(key, kept ? preferredListing(kept, candidate) : candidate);
  }
  return [...byEndpoint.values()];
}

/** One sync of one source (the official MCP Registry by default). Never throws: a failure is its outcome. */
export async function syncConnectorCatalogue(
  db: ApiDatabase,
  {
    source = 'mcp_registry',
    read = CATALOGUE_SOURCES.find((item) => item.source === source)?.read ?? readOfficialRegistry,
    curated = MCP_REGISTRY,
    earlierEndpoints = new Set(),
    overrides = CATALOGUE_OVERRIDES,
    now = new Date(),
  }: CatalogueSyncOptions = {},
): Promise<CatalogueSyncOutcome> {
  const state = await getCatalogueSyncState(db, source);
  if (state?.retryAfter && state.retryAfter > now) {
    return { status: 'deferred', until: state.retryAfter };
  }

  let pass: CataloguePass;
  try {
    pass = await read();
  } catch (err: unknown) {
    const retryAt = err instanceof CatalogueRateLimitError ? err.retryAt : null;
    const error = err instanceof Error ? err.message : String(err);
    await recordCatalogueSyncFailure(db, source, error, retryAt, now);
    log.general.warn({ err, retryAt, source }, 'Connector catalogue sync failed');
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
  const candidates = selectCandidates(pass, curated, overrides, report, earlierEndpoints);
  report.candidates = candidates.length;

  const stored = new Map(
    (await listCatalogueRowsOfSource(db, source)).map((row) => [row.id, row] as const),
  );
  const inserts: NewMcpCatalogueRow[] = [];
  for (const candidate of candidates) {
    const row = stored.get(candidate.id);
    stored.delete(candidate.id);
    if (!row) {
      inserts.push({ ...candidate, firstSeenAt: now });
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

  await recordCatalogueSyncSuccess(db, source, { ...report }, now);
  log.general.info({ report, source }, 'Connector catalogue synced');
  return { status: 'synced', report };
}

/**
 * Sync every source that is due, the primary first, each one told which endpoints the sources
 * before it list (as they stand after their own sync), so one server is listed once.
 */
export async function syncCatalogueSources(
  db: ApiDatabase,
  {
    now = new Date(),
    isDue,
    sources = CATALOGUE_SOURCES,
    curated = MCP_REGISTRY,
    overrides = CATALOGUE_OVERRIDES,
  }: {
    now?: Date;
    isDue: (source: McpCatalogueSource) => Promise<boolean>;
    sources?: typeof CATALOGUE_SOURCES;
    curated?: readonly McpRegistryEntry[];
    overrides?: Readonly<Record<string, CatalogueOverride>>;
  },
): Promise<Partial<Record<McpCatalogueSource, CatalogueSyncOutcome>>> {
  const outcomes: Partial<Record<McpCatalogueSource, CatalogueSyncOutcome>> = {};
  const earlierEndpoints = new Set<string>();
  for (const { source, read } of sources) {
    if (await isDue(source)) {
      outcomes[source] = await syncConnectorCatalogue(db, {
        source,
        read,
        curated,
        overrides,
        earlierEndpoints,
        now,
      });
    }
    for (const row of await listCatalogueRowsOfSource(db, source)) {
      if (row.removedAt === null) earlierEndpoints.add(endpointKey(row.url));
    }
  }
  return outcomes;
}
