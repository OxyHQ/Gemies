/**
 * What of a public registry the store takes, and how it presents it.
 *
 * A server is a candidate only when it can be connected the way every connector is (ADR: only
 * remote, provider-hosted MCP servers, nothing run on our hosts):
 *
 * - it has a remote endpoint, streamable HTTP (preferred) or SSE, at an `https` URL with no
 *   `{template}` the person would have to fill in; a server that is only a package (`npx`, a
 *   container, stdio) is not;
 * - that endpoint needs no header the registry marks required (an API key pasted by hand is the
 *   custom connector's job, not the store's);
 * - it is `active` in its registry, and not denied below.
 *
 * Whether its sign-in is one Gemies supports (none, or OAuth with Dynamic Client Registration) is
 * learnt by its health check (`health.ts`), not believed from the registry.
 *
 * Everything shown is the registry's text, sanitised (`untrustedPlainText`).
 */

import { createHash } from 'node:crypto';
import {
  type ConnectorCategory,
  type ConnectorIcon,
  MCP_CATALOGUE_SOURCES,
  type McpCatalogueTrust,
  type McpServerTransport,
} from '../../db/schema/integrations.js';
import { untrustedPlainText } from '../untrusted-text.js';
import type { RegistryServer } from './official-registry.js';

export const MAX_NAME_LENGTH = 60;
export const MAX_DESCRIPTION_LENGTH = 280;
const MAX_SLUG_LENGTH = 24;
const MAX_ICONS = 8;

/** Why a listed server is not in the store. Counted in every sync report. */
export type CandidateRefusal =
  | 'not_active'
  | 'no_remote'
  | 'not_https'
  | 'templated_url'
  | 'requires_headers'
  | 'denied'
  | 'bulk_publisher';

/**
 * More servers than one publisher plausibly runs by hand. The registry holds publishers that
 * generated thousands of near-identical listings (one per API endpoint, per city, per sensor); a
 * namespace past this is a listing farm, left out whole unless an override admits it
 * (`allowBulk`).
 */
export const MAX_SERVERS_PER_PUBLISHER = 25;

/** A server the store may offer once its health check passes. */
export interface CatalogueCandidate {
  id: string;
  upstreamName: string;
  upstreamVersion: string;
  upstreamUpdatedAt: Date | null;
  slug: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  trust: McpCatalogueTrust;
  url: string;
  transport: McpServerTransport;
  websiteUrl: string | null;
  repositoryUrl: string | null;
  icons: ConnectorIcon[];
}

// ---------------------------------------------------------------------------
// Denylist and operator overrides
// ---------------------------------------------------------------------------

/**
 * The operator's say over synced servers, reviewed like any code change. Keyed by the server's
 * name in its registry, by `host:<hostname>` for every server reached on that host or under it, or by
 * `publisher:<namespace>` for every server of a publisher (`io.github.ana`, `com.example`). `hide`
 * keeps a server out of the store whatever it passes (a sync skips it and the store stops offering
 * it on the next deploy); `allowBulk` admits a publisher past `MAX_SERVERS_PER_PUBLISHER`; the rest
 * correct what the registry or the classifier got wrong.
 *
 * Connections a person already made to a hidden server are theirs and keep working until they
 * disconnect them.
 */
export interface CatalogueOverride {
  hide?: string;
  allowBulk?: boolean;
  category?: ConnectorCategory;
  trust?: McpCatalogueTrust;
  featured?: boolean;
}

export const CATALOGUE_OVERRIDES: Readonly<Record<string, CatalogueOverride>> = {
  // Smithery's hosted proxies, which Smithery shut down on 2026-10-31 (they answer 401): a listing
  // reached through them is neither the provider's server nor reachable.
  'host:server.smithery.ai': { hide: 'Smithery proxy, shut down 2026-10-31' },
  'host:run.tools': { hide: 'Smithery proxy, shut down 2026-10-31' },
};

/** The override for a server: by name first, then by the host it is reached on. */
export function catalogueOverride(
  upstreamName: string,
  url: string,
  overrides: Readonly<Record<string, CatalogueOverride>> = CATALOGUE_OVERRIDES,
): CatalogueOverride | undefined {
  return (
    overrides[upstreamName] ??
    hostOverride(url, overrides) ??
    overrides[`publisher:${publisherOf(upstreamName)}`]
  );
}

/** `host:example.com` covers `example.com` and every host under it (`mcp.example.com`). */
function hostOverride(
  url: string,
  overrides: Readonly<Record<string, CatalogueOverride>>,
): CatalogueOverride | undefined {
  if (!URL.canParse(url)) return undefined;
  const labels = new URL(url).hostname.toLowerCase().split('.');
  for (let start = 0; start < labels.length - 1; start += 1) {
    const override = overrides[`host:${labels.slice(start).join('.')}`];
    if (override) return override;
  }
  return undefined;
}

/** The namespace a server was published under, which its publisher proved: `com.notion`. */
export function publisherOf(upstreamName: string): string {
  return upstreamName.split('/')[0] ?? upstreamName;
}

// ---------------------------------------------------------------------------
// Reading a registry server
// ---------------------------------------------------------------------------

/** `com.example.mcp` → `mcp.example.com`; `null` for a GitHub namespace. */
export function namespaceDomain(upstreamName: string): string | null {
  const namespace = upstreamName.split('/')[0]?.toLowerCase() ?? '';
  if (!namespace || namespace.startsWith('io.github.')) return null;
  const labels = namespace.split('.').filter(Boolean);
  return labels.length >= 2 ? labels.reverse().join('.') : null;
}

/**
 * The badge a server earns from how its publisher proved who they are, and where it is reached:
 * `official` is a proven domain serving its own server (`com.notion/mcp` at `mcp.notion.com`).
 */
export function trustOf(upstreamName: string, url: string): McpCatalogueTrust {
  const domain = namespaceDomain(upstreamName);
  if (!domain) return 'community';
  const host = new URL(url).hostname.toLowerCase();
  // The proven domain itself or a host under it; never a parent, which without the public suffix
  // list could be `co.uk`.
  return host === domain || host.endsWith(`.${domain}`) ? 'official' : 'verified';
}

const CATEGORY_WORDS: readonly [ConnectorCategory, RegExp][] = [
  [
    'design',
    /\b(design|figma|canva|ui kit|icons?|illustration|image generation|diagram|whiteboard|3d)\b/i,
  ],
  [
    'finance',
    /\b(financ\w*|bank\w*|payments?|invoic\w*|accounting|crypto\w*|blockchain|wallets?|stocks?|trading|tax|ledger|defi|token prices?)\b/i,
  ],
  [
    'commerce',
    /\b(e-?commerce|shop\w*|store|products?|orders?|checkout|retail|marketplace|booking|reservations?|travel|hotels?|flights?)\b/i,
  ],
  [
    'marketing',
    /\b(marketing|seo|ads|advertis\w*|campaigns?|newsletter|social media|crm|leads?|sales)\b/i,
  ],
  [
    'communication',
    /\b(email|e-mail|mail|inbox|chat|messag\w*|slack|teams|discord|telegram|whatsapp|sms|calls?|meetings?|calendar|video)\b/i,
  ],
  [
    'development',
    /\b(code|coding|developer|github|gitlab|git|deploy\w*|ci|devops|kubernetes|docker|api testing|debug\w*|logs?|observability|monitoring|database schema|sdk|cloud|infrastructure|hosting|domains?|dns)\b/i,
  ],
  [
    'data',
    /\b(data|analytics|sql|database|warehouse|metrics|dashboards?|bi|spreadsheets?|csv|charts?|statistics)\b/i,
  ],
  [
    'search',
    /\b(search|web scrap\w*|scrap\w*|crawl\w*|browse\w*|research|news|knowledge|docs|documentation|wiki\w*)\b/i,
  ],
  [
    'productivity',
    /\b(tasks?|projects?|notes?|to-?do|documents?|productivity|workspace|wiki|forms?|files?|drive|storage|automation|workflow)\b/i,
  ],
];

/** A store category from a server's name and description; `other` when nothing reads as one. */
export function categoryOf(name: string, description: string): ConnectorCategory {
  const text = `${name} ${description}`;
  for (const [category, words] of CATEGORY_WORDS) {
    if (words.test(text)) return category;
  }
  return 'other';
}

const GENERIC_SLUGS = new Set(['mcp', 'server', 'mcp_server', 'remote', 'api', 'site', 'app']);

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/(^|_)mcp(_server)?(_|$)/g, '$1$3')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The base of a connection's slug, which names its tools (`mcp_<slug>__<tool>`): short, so a tool
 * name stays under the 64 characters providers accept. From the title, else the name's last part,
 * else the publisher's domain; a person's second connection of it gets `_2` (`insertMcpServer`).
 */
export function slugOf(upstreamName: string, title: string): string {
  const [namespace = '', path = ''] = upstreamName.split('/');
  const domainLabel = (namespaceDomain(upstreamName) ?? namespace.replace(/^io\.github\./, ''))
    .split('.')
    .at(namespaceDomain(upstreamName) ? -2 : 0);
  for (const candidate of [title, path, domainLabel ?? '']) {
    const slug = slugify(candidate).slice(0, MAX_SLUG_LENGTH).replace(/_+$/, '');
    if (slug && !GENERIC_SLUGS.has(slug)) return slug;
  }
  return `mcp_${createHash('sha256').update(upstreamName).digest('hex').slice(0, 8)}`;
}

/** The address two listings of one server share, whatever registry or version lists it. */
export function endpointKey(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${path}`;
}

function httpsUrlOrNull(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === 'https:' ? url.toString() : null;
}

function icons(server: RegistryServer['server']): ConnectorIcon[] {
  return (server.icons ?? [])
    .filter((icon) => icon.src.startsWith('https://') || icon.src.startsWith('data:image/'))
    .slice(0, MAX_ICONS)
    .map((icon) => ({
      src: icon.src,
      ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
      ...(icon.sizes ? { sizes: icon.sizes.slice(0, 8) } : {}),
    }));
}

/** The store's reading of one registry server, or why it is not a candidate. */
export function candidateFromRegistry(
  listed: RegistryServer,
  overrides: Readonly<Record<string, CatalogueOverride>> = CATALOGUE_OVERRIDES,
): { ok: true; candidate: CatalogueCandidate } | { ok: false; reason: CandidateRefusal } {
  const { server } = listed;
  const official = listed._meta?.['io.modelcontextprotocol.registry/official'];
  if (official?.status && official.status !== 'active') return { ok: false, reason: 'not_active' };

  const remotes = (server.remotes ?? []).filter(
    (remote) => remote.type === 'streamable-http' || remote.type === 'sse',
  );
  if (remotes.length === 0) return { ok: false, reason: 'no_remote' };
  const https = remotes.filter(
    (remote) => URL.canParse(remote.url) && new URL(remote.url).protocol === 'https:',
  );
  if (https.length === 0) return { ok: false, reason: 'not_https' };
  const concrete = https.filter((remote) => !remote.url.includes('{') && !remote.variables);
  if (concrete.length === 0) return { ok: false, reason: 'templated_url' };
  const open = concrete.filter((remote) => !remote.headers?.some((header) => header.isRequired));
  if (open.length === 0) return { ok: false, reason: 'requires_headers' };
  const chosen = open.find((remote) => remote.type === 'streamable-http') ?? open[0];

  const override = catalogueOverride(server.name, chosen.url, overrides);
  if (override?.hide) return { ok: false, reason: 'denied' };

  const name =
    untrustedPlainText(server.title, MAX_NAME_LENGTH) ||
    untrustedPlainText(server.name.split('/').at(-1), MAX_NAME_LENGTH) ||
    server.name;
  const description = untrustedPlainText(server.description, MAX_DESCRIPTION_LENGTH);
  const updatedAt = official?.updatedAt ? new Date(official.updatedAt) : null;
  return {
    ok: true,
    candidate: {
      id: syncedEntryId(server.name),
      upstreamName: server.name,
      upstreamVersion: server.version.slice(0, 64),
      upstreamUpdatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
      slug: slugOf(server.name, name),
      name,
      description,
      category: override?.category ?? categoryOf(name, description),
      trust: override?.trust ?? trustOf(server.name, chosen.url),
      url: chosen.url,
      transport: chosen.type as McpServerTransport,
      websiteUrl: httpsUrlOrNull(server.websiteUrl),
      repositoryUrl: httpsUrlOrNull(server.repository?.url),
      icons: icons(server),
    },
  };
}

/** A synced entry's id: its registry and its name there, never the shape of a curated id. */
export function syncedEntryId(upstreamName: string): string {
  return `mcp_registry:${upstreamName}`;
}

export function isSyncedEntryId(id: string): boolean {
  return MCP_CATALOGUE_SOURCES.some((source) => id.startsWith(`${source}:`));
}

const TRUST_RANK: Record<McpCatalogueTrust, number> = { official: 0, verified: 1, community: 2 };

/**
 * One candidate per endpoint: two listings of the same address (a server republished under
 * another name, or by somebody else) are one server, and the store keeps the best-proven
 * publisher's listing, then the most recently updated.
 */
export function preferredListing(a: CatalogueCandidate, b: CatalogueCandidate): CatalogueCandidate {
  const rank = TRUST_RANK[a.trust] - TRUST_RANK[b.trust];
  if (rank !== 0) return rank < 0 ? a : b;
  const at = a.upstreamUpdatedAt?.getTime() ?? 0;
  const bt = b.upstreamUpdatedAt?.getTime() ?? 0;
  if (at !== bt) return at > bt ? a : b;
  return a.upstreamName <= b.upstreamName ? a : b;
}
