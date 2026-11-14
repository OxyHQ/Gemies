/**
 * Reading the official MCP Registry (`registry.modelcontextprotocol.io`), the store's source of
 * synced servers.
 *
 * The registry is the Model Context Protocol project's own catalogue: every server is a
 * `server.json` its publisher pushed under a namespace they proved (a reverse-DNS name through a DNS
 * TXT record or `/.well-known/mcp-registry-auth`, or `io.github.<login>` through GitHub). It does not
 * check that a remote is on the proven domain; `policy.ts` does, for the badge. Its terms dedicate
 * the registry data to the public domain (CC0 1.0, §10) and let subregistries like this store copy,
 * enrich and process it (§11), as long as nothing implies a partnership (§6). Its API is public,
 * needs no key and documents no rate limit; it asks aggregators to poll regularly but infrequently
 * and never per user request (modelcontextprotocol.io/registry/registry-aggregators). This reads it
 * a page of 100 at a time, one page after another with a pause between, asks a page again after a
 * passing failure (the network, a 5xx), and stops for the run at the first 429, keeping its
 * `Retry-After`.
 *
 * Only the latest version of each server is read (`version=latest`). A page that does not parse is
 * a failed pass: the sync then changes nothing (`sync.ts`).
 */

import { z } from 'zod';
import {
  CatalogueRateLimitError,
  type CataloguePass,
  type ListedServer,
  trustOf,
} from './policy.js';

export const OFFICIAL_REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';
const SERVERS_PATH = '/v0.1/servers';
const PAGE_SIZE = 100;
/** Between two pages: well under the registry's limits, and a full pass still takes minutes. */
const PAGE_PAUSE_MS = 250;
const PAGE_TIMEOUT_MS = 30_000;
/** A page larger than this is not the registry's: it is refused rather than parsed. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** Far more pages than the registry has, so a cursor that never ends cannot loop for ever. */
const MAX_PAGES = 2_000;
const USER_AGENT = 'GemiesConnectorCatalogue/1.0 (+https://gemies.ai)';

const icon = z.object({
  src: z.string(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
});

const remote = z.object({
  type: z.string(),
  url: z.string(),
  headers: z
    .array(
      z.object({
        name: z.string(),
        isRequired: z.boolean().optional(),
        isSecret: z.boolean().optional(),
      }),
    )
    .optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
});

const listedServer = z.object({
  server: z.object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional() }).partial().optional(),
    icons: z.array(icon).optional(),
    remotes: z.array(remote).optional(),
  }),
  _meta: z
    .object({
      'io.modelcontextprotocol.registry/official': z
        .object({
          status: z.string().optional(),
          updatedAt: z.string().optional(),
          isLatest: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

const page = z.object({
  servers: z.array(z.unknown()),
  metadata: z.object({ nextCursor: z.string().nullish(), count: z.number().optional() }).optional(),
});

/** One server as the registry lists it, already shape-checked. */
export type RegistryServer = z.infer<typeof listedServer>;

export class RegistryHttpError extends Error {
  constructor(readonly status: number) {
    super(`The MCP Registry answered ${status}`);
  }
}

/** A registry server as the store judges every catalogue's (`policy.ts`). */
export function listedFromRegistry(listed: RegistryServer): ListedServer {
  const { server } = listed;
  const official = listed._meta?.['io.modelcontextprotocol.registry/official'];
  return {
    source: 'mcp_registry',
    name: server.name,
    version: server.version,
    updatedAt: official?.updatedAt ? new Date(official.updatedAt) : null,
    active: !official?.status || official.status === 'active',
    title: server.title,
    description: server.description,
    websiteUrl: server.websiteUrl,
    repositoryUrl: server.repository?.url,
    icons: server.icons ?? [],
    remotes: (server.remotes ?? []).map((remote) => ({
      type: remote.type,
      url: remote.url,
      requiresHeaders: remote.headers?.some((header) => header.isRequired) ?? false,
      templated: Boolean(remote.variables) || remote.url.includes('{'),
    })),
    publisher: server.name.split('/')[0] ?? server.name,
    trustAt: (url) => trustOf(server.name, url),
  };
}

/** When a 429 says to come back: its `Retry-After`, or an hour. */
function retryAtOf(response: Response, now: Date): Date {
  const header = response.headers.get('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return new Date(now.getTime() + seconds * 1000);
  const date = header ? Date.parse(header) : Number.NaN;
  return Number.isNaN(date) ? new Date(now.getTime() + 60 * 60 * 1000) : new Date(date);
}

async function readPage(
  cursor: string | null,
  fetchImpl: typeof fetch,
): Promise<z.infer<typeof page>> {
  const url = new URL(SERVERS_PATH, OFFICIAL_REGISTRY_ORIGIN);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('version', 'latest');
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (response.status === 429) {
    throw new CatalogueRateLimitError(retryAtOf(response, new Date()), 'The MCP Registry');
  }
  if (!response.ok) throw new RegistryHttpError(response.status);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_PAGE_BYTES) throw new Error('The MCP Registry page is too large');
  const text = await response.text();
  if (text.length > MAX_PAGE_BYTES) throw new Error('The MCP Registry page is too large');
  return page.parse(JSON.parse(text));
}

/** A page that failed for a reason that passes (the network, a 5xx) is asked again, twice. */
const PAGE_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 2_000;

async function readPageWithRetries(
  cursor: string | null,
  fetchImpl: typeof fetch,
  pauseMs: number,
): Promise<z.infer<typeof page>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readPage(cursor, fetchImpl);
    } catch (err: unknown) {
      const lasting =
        err instanceof CatalogueRateLimitError ||
        err instanceof z.ZodError ||
        err instanceof SyntaxError ||
        (err instanceof RegistryHttpError && err.status < 500);
      if (lasting || attempt >= PAGE_ATTEMPTS) throw err;
      if (pauseMs > 0)
        await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS * attempt));
    }
  }
}

/**
 * Every server's latest version, the whole registry in one pass. Throws when a page cannot be read
 * (and `CatalogueRateLimitError` on a 429): a partial pass is never returned, because the sync
 * reads a server missing from a pass as removed.
 */
export async function readOfficialRegistry(
  fetchImpl: typeof fetch = fetch,
  pauseMs = PAGE_PAUSE_MS,
): Promise<CataloguePass> {
  const servers: ListedServer[] = [];
  let malformed = 0;
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const current = await readPageWithRetries(cursor, fetchImpl, pauseMs);
    for (const item of current.servers) {
      const parsed = listedServer.safeParse(item);
      if (parsed.success) servers.push(listedFromRegistry(parsed.data));
      else malformed += 1;
    }
    cursor = current.metadata?.nextCursor ?? null;
    if (!cursor || current.servers.length === 0) return { servers, malformed };
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  throw new Error('The MCP Registry listing did not end');
}
