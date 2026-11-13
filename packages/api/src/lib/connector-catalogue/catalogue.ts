/**
 * The connectors store as people see it: the curated entries (`lib/mcp-registry.ts`) and the synced
 * ones (`mcp_catalogue_entries`), one list.
 *
 * - A **curated** entry is offered when this deployment holds what it needs (its issued client, its
 *   approval: `isRegistryEntryConfigured`). It is the provider's own server, so it is `official`.
 * - A **synced** entry is offered while it is listed upstream, its health check passed, its sign-in
 *   is none or OAuth with Dynamic Client Registration, and no override hides it. Its id
 *   (`mcp_registry:<name>`) never equals a curated one, and the sync never takes a server the
 *   curated catalogue has, so a synced entry never stands in for a curated one.
 *
 * The synced rows are read at most once a minute per process; the curated ones are code.
 */

import type { ApiDatabase } from '../../db/index.js';
import {
  listOfferedCatalogueRows,
  type McpCatalogueRow,
} from '../../db/integrations/mcpCatalogueRepository.js';
import {
  CONNECTOR_CATEGORIES,
  type ConnectorCategory,
  type McpCatalogueTrust,
  type McpServerTransport,
} from '../../db/schema/integrations.js';
import type { LogoSubject } from '../connector-logos.js';
import { connectorCallbackUrl } from '../connector-return.js';
import {
  isRegistryEntryConfigured,
  registryIntegrationsConfig,
  type IntegrationsMcpConfig,
} from '../mcp-connector-config.js';
import { MCP_REGISTRY, type McpRegistryEntry } from '../mcp-registry.js';
import { TTLCache } from '../ttl-cache.js';
import { CATALOGUE_OVERRIDES, type CatalogueOverride, catalogueOverride } from './policy.js';

export interface CatalogueEntry {
  id: string;
  /** The base of a connection's slug (`mcp_<slug>__<tool>`). */
  slug: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  url: string;
  transport: McpServerTransport;
  /** How a person connects it: through the provider's sign-in, or at once. */
  signIn: 'oauth' | 'none';
  trust: McpCatalogueTrust;
  /** `curated` by Gemies, or synced from the official MCP Registry. */
  source: 'curated' | 'mcp_registry';
  featured: boolean;
  /** Where to read about it: the provider's documentation, or the server's website. */
  docsUrl: string | null;
  /** Its tool count, when it was listed without a sign-in. */
  toolCount: number | null;
  /** When it last changed upstream, for "recently added". */
  updatedAt: Date | null;
  /** The curated entry, whose OAuth settings it is reached with. */
  curated?: McpRegistryEntry;
}

function fromCurated(entry: McpRegistryEntry): CatalogueEntry {
  return {
    id: entry.id,
    slug: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    url: entry.url,
    transport: 'streamable-http',
    signIn: 'oauth',
    trust: 'official',
    source: 'curated',
    featured: entry.featured ?? false,
    docsUrl: entry.docsUrl,
    toolCount: null,
    updatedAt: null,
    curated: entry,
  };
}

function fromSynced(
  row: McpCatalogueRow,
  overrides: Readonly<Record<string, CatalogueOverride>>,
): CatalogueEntry | null {
  const override = catalogueOverride(row.upstreamName, row.url, overrides);
  if (override?.hide) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: override?.category ?? row.category,
    url: row.url,
    transport: row.transport,
    signIn: row.auth === 'none' ? 'none' : 'oauth',
    trust: override?.trust ?? row.trust,
    source: row.source,
    featured: override?.featured ?? false,
    docsUrl: row.websiteUrl ?? row.repositoryUrl,
    toolCount: row.toolCount,
    updatedAt: row.upstreamUpdatedAt ?? row.firstSeenAt,
  };
}

const syncedCache = new TTLCache<McpCatalogueRow[]>({ ttlMs: 60_000, maxSize: 1 });

async function offeredRows(db: ApiDatabase): Promise<McpCatalogueRow[]> {
  const cached = syncedCache.get('offered');
  if (cached) return cached;
  const rows = await listOfferedCatalogueRows(db);
  syncedCache.set('offered', rows);
  return rows;
}

/** Forget the synced rows read, so the next read sees what the catalogue job just wrote. */
export function invalidateCatalogue(): void {
  syncedCache.clear();
}

/** Every entry this deployment offers, curated first. */
export async function listCatalogue(
  db: ApiDatabase,
  {
    env = process.env,
    overrides = CATALOGUE_OVERRIDES,
  }: { env?: NodeJS.ProcessEnv; overrides?: Readonly<Record<string, CatalogueOverride>> } = {},
): Promise<CatalogueEntry[]> {
  const curated = MCP_REGISTRY.filter((entry) => isRegistryEntryConfigured(entry, env)).map(
    fromCurated,
  );
  const synced = (await offeredRows(db).catch(() => [])).flatMap(
    (row) => fromSynced(row, overrides) ?? [],
  );
  return [...curated, ...synced];
}

/** The entry a person connects, when this deployment offers it. */
export async function findCatalogueEntry(
  db: ApiDatabase,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogueEntry | undefined> {
  const curated = MCP_REGISTRY.find((entry) => entry.id === id);
  if (curated) return isRegistryEntryConfigured(curated, env) ? fromCurated(curated) : undefined;
  return (await listCatalogue(db, { env })).find((entry) => entry.id === id);
}

/** The config integrations reaches a new account of an entry with. */
export function catalogueIntegrationsConfig(
  entry: CatalogueEntry,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationsMcpConfig {
  if (entry.curated) return registryIntegrationsConfig(entry.curated, env);
  return {
    url: entry.url,
    requiresOAuth: entry.signIn === 'oauth',
    oauthCallbackUrl: connectorCallbackUrl(env),
  };
}

/** Whose logos the catalogue job keeps: every curated entry, and every synced one offered. */
export async function catalogueLogoSubjects(db: ApiDatabase): Promise<LogoSubject[]> {
  const curated = MCP_REGISTRY.map((entry) => ({
    registryId: entry.id,
    website: entry.website,
    ...(entry.mcpRegistryName ? { mcpRegistryName: entry.mcpRegistryName } : {}),
  }));
  const synced = (await listOfferedCatalogueRows(db)).map((row) => ({
    registryId: row.id,
    icons: row.icons,
    website: row.websiteUrl ?? new URL(row.url).origin,
  }));
  return [...curated, ...synced];
}

// ---------------------------------------------------------------------------
// The store's query: search, filters, sort and pages
// ---------------------------------------------------------------------------

export const CATALOGUE_SORTS = ['featured', 'name', 'recent'] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

export interface CatalogueQuery {
  q?: string;
  category?: ConnectorCategory;
  /** Only these badges (`official`, `verified`, `community`). */
  trust?: readonly McpCatalogueTrust[];
  /** Only entries that connect without a sign-in. */
  noSignIn?: boolean;
  sort?: CatalogueSort;
  offset?: number;
  limit?: number;
}

const TRUST_RANK: Record<McpCatalogueTrust, number> = { official: 0, verified: 1, community: 2 };
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function compareBy(sort: CatalogueSort) {
  const byName = (a: CatalogueEntry, b: CatalogueEntry) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  if (sort === 'name') return byName;
  if (sort === 'recent') {
    return (a: CatalogueEntry, b: CatalogueEntry) =>
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0) || byName(a, b);
  }
  return (a: CatalogueEntry, b: CatalogueEntry) =>
    Number(b.featured) - Number(a.featured) ||
    Number(b.source === 'curated') - Number(a.source === 'curated') ||
    TRUST_RANK[a.trust] - TRUST_RANK[b.trust] ||
    byName(a, b);
}

/**
 * One page of the store, and how many entries each category holds under the same search and
 * filters (the category chips' counts).
 */
export function queryCatalogue(entries: readonly CatalogueEntry[], query: CatalogueQuery) {
  const words = (query.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = entries.filter(
    (entry) =>
      (!query.trust?.length || query.trust.includes(entry.trust)) &&
      (!query.noSignIn || entry.signIn === 'none') &&
      words.every((word) => `${entry.name} ${entry.description}`.toLowerCase().includes(word)),
  );
  const categories = CONNECTOR_CATEGORIES.map((id) => ({
    id,
    count: filtered.filter((entry) => entry.category === id).length,
  })).filter((category) => category.count > 0);
  const inCategory = query.category
    ? filtered.filter((entry) => entry.category === query.category)
    : filtered;
  const sorted = [...inCategory].sort(compareBy(query.sort ?? 'featured'));
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
  const page = sorted.slice(offset, offset + limit);
  return {
    entries: page,
    total: sorted.length,
    nextOffset: offset + page.length < sorted.length ? offset + page.length : null,
    categories,
  };
}
