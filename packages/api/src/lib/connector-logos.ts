/**
 * Connector logos: where each one comes from, and how Gemies keeps it.
 *
 * A logo is read from, in order:
 *
 *  1. **The server itself** — `serverInfo.icons` in its MCP `initialize` answer
 *     (spec 2025-11-25), read when the connector connects. Providers' servers
 *     answer `initialize` only with a token, so this is known per connection.
 *  2. **The official MCP Registry** — the `icons` of the entry's `server.json`
 *     (`registry.modelcontextprotocol.io`), for a catalogue entry that is listed.
 *  3. **The provider's website** — its brand mark: `apple-touch-icon`, then an
 *     SVG or PNG `icon` link, then `/apple-touch-icon.png` and `/favicon.ico`.
 *
 * With none of them the client draws a monogram (`ConnectorLogo` in
 * `@gemies/sdk/connectors`), never a broken image.
 *
 * Every image is fetched here, through `safeFetch` (each hop's address judged,
 * the connection pinned to it, https only), checked by its BYTES rather than by
 * the type the server claimed, capped at `CONNECTOR_LOGO_MAX_BYTES`, and stored
 * in `connector_logos` under its SHA-256. The app loads logos only from the
 * API's own origin (`GET /mcp/logos/:id`, `servedLogo`), so no provider URL is
 * ever hot-linked and the web app's CSP (`img-src` the API) holds.
 */

import { createHash } from 'node:crypto';
import { readResponseBody, safeFetch } from '@oxy.so/core/server';
import { eq } from 'drizzle-orm';
import type { ApiDatabase } from '../db/index.js';
import {
  CONNECTOR_LOGO_MAX_BYTES,
  connectorLogos,
  mcpRegistryLogos,
  type ConnectorLogoSource,
  type ConnectorLogoType,
} from '../db/schema/integrations.js';
import { log } from './logger.js';
import { MCP_REGISTRY, type McpRegistryEntry } from './mcp-registry.js';

const FETCH_HEADERS_TIMEOUT_MS = 8_000;
const FETCH_BODY_TIMEOUT_MS = 8_000;
/** A website's HTML is read only as far as its `<head>` needs. */
const MAX_HTML_BYTES = 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; GemiesConnectorLogos/1.0; +https://gemies.ai)';
const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0.1/servers';
/** How long a catalogue logo is trusted before it is read again. */
const REGISTRY_LOGO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One icon as MCP describes it (`Icon`): a URL or a `data:` URI, with optional hints. */
export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

/** What the bytes are, by their signature. `null` is anything that is not an image we serve. */
export function sniffLogoType(bytes: Buffer): ConnectorLogoType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  const head = bytes.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Keep an image and answer its id, or `null` when it is not one we serve. */
export async function storeLogo(db: ApiDatabase, bytes: Buffer): Promise<string | null> {
  if (bytes.length === 0 || bytes.length > CONNECTOR_LOGO_MAX_BYTES) return null;
  const contentType = sniffLogoType(bytes);
  if (!contentType) return null;
  const id = createHash('sha256').update(bytes).digest('hex');
  await db.insert(connectorLogos).values({ id, contentType, bytes }).onConflictDoNothing();
  return id;
}

/** Read an image from a URL (or a `data:` URI), or `null` when it cannot be read as one. */
async function readImage(src: string): Promise<Buffer | null> {
  if (src.startsWith('data:')) return decodeDataUri(src);
  const body = await readHttps(src, CONNECTOR_LOGO_MAX_BYTES);
  return body && sniffLogoType(body) ? body : null;
}

function decodeDataUri(src: string): Buffer | null {
  const match = /^data:image\/[a-z0-9.+-]+(;base64)?,(.*)$/is.exec(src);
  if (!match) return null;
  const bytes = match[1]
    ? Buffer.from(match[2], 'base64')
    : Buffer.from(decodeURIComponent(match[2]), 'utf8');
  return bytes.length <= CONNECTOR_LOGO_MAX_BYTES && sniffLogoType(bytes) ? bytes : null;
}

/** GET an https URL through the SSRF guard, its body capped; `null` on any failure. */
async function readHttps(url: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const { response, status } = await safeFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,text/html;q=0.9,*/*;q=0.5' },
      headersTimeoutMs: FETCH_HEADERS_TIMEOUT_MS,
      requireHttps: true,
    });
    if (status < 200 || status >= 300) {
      response.destroy();
      return null;
    }
    const read = await readResponseBody(response, { maxBytes, timeoutMs: FETCH_BODY_TIMEOUT_MS });
    return read.kind === 'ok' ? read.body : null;
  } catch {
    return null;
  }
}

/** The largest side an icon declares (`48x48`, `any` = vector), for choosing among several. */
function iconSize(icon: McpIcon): number {
  if (icon.sizes?.includes('any') || icon.mimeType === 'image/svg+xml') return 10_000;
  return Math.max(0, ...(icon.sizes ?? []).map((size) => Number.parseInt(size, 10) || 0));
}

/** The first of these icons that reads as an image, largest first; its stored id or `null`. */
export async function storeFirstIcon(
  db: ApiDatabase,
  icons: readonly McpIcon[],
): Promise<string | null> {
  const ordered = [...icons]
    .filter((icon) => typeof icon?.src === 'string')
    .sort((a, b) => iconSize(b) - iconSize(a));
  for (const icon of ordered.slice(0, 4)) {
    const bytes = await readImage(icon.src);
    if (bytes) {
      const id = await storeLogo(db, bytes);
      if (id) return id;
    }
  }
  return null;
}

/** The icons of a server in the official MCP Registry, newest version first. */
async function mcpRegistryIcons(name: string): Promise<McpIcon[]> {
  const body = await readHttps(
    `${MCP_REGISTRY_API}?search=${encodeURIComponent(name)}&version=latest`,
    MAX_HTML_BYTES,
  );
  if (!body) return [];
  try {
    const listing = JSON.parse(body.toString('utf8')) as {
      servers?: { server?: { name?: string; icons?: McpIcon[] } }[];
    };
    return (listing.servers ?? [])
      .map((item) => item.server)
      .filter((server) => server?.name === name)
      .flatMap((server) => server?.icons ?? []);
  } catch {
    return [];
  }
}

/** A website's brand mark candidates, best first, as absolute https URLs. */
export function brandMarkCandidates(html: string, pageUrl: string): string[] {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const attr = (tag: string, name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];
  const ranked: { href: string; rank: number }[] = [];
  for (const tag of links) {
    const rel = attr(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const href = attr(tag, 'href');
    if (!href) continue;
    const type = attr(tag, 'type')?.toLowerCase() ?? '';
    const size = Number.parseInt(attr(tag, 'sizes') ?? '', 10) || 0;
    if (rel.includes('apple-touch-icon')) ranked.push({ href, rank: 3000 + size });
    else if (
      rel.includes('icon') &&
      (type.includes('svg') || href.split('?')[0].endsWith('.svg'))
    ) {
      ranked.push({ href, rank: 2500 });
    } else if (rel.includes('icon') && !href.split('?')[0].endsWith('.ico')) {
      ranked.push({ href, rank: 1000 + size });
    }
  }
  const origin = new URL(pageUrl).origin;
  const urls = [
    ...ranked.sort((a, b) => b.rank - a.rank).map((item) => item.href),
    `${origin}/apple-touch-icon.png`,
    ...links
      .filter((tag) => /\brel\s*=\s*["'][^"']*icon/i.test(tag))
      .map((tag) => attr(tag, 'href'))
      .filter((href): href is string => !!href && href.split('?')[0].endsWith('.ico')),
    `${origin}/favicon.ico`,
  ];
  const absolute = urls.flatMap((href) => {
    try {
      const url = new URL(href, pageUrl);
      return url.protocol === 'https:' ? [url.toString()] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(absolute)];
}

/** The brand mark of a website: the first candidate that reads as an image. */
async function websiteBrandMark(
  db: ApiDatabase,
  website: string,
): Promise<{ logoId: string; sourceUrl: string } | null> {
  const html = (await readHttps(website, MAX_HTML_BYTES))?.toString('utf8') ?? '';
  for (const candidate of brandMarkCandidates(html, website).slice(0, 6)) {
    const bytes = await readImage(candidate);
    const logoId = bytes ? await storeLogo(db, bytes) : null;
    if (logoId) return { logoId, sourceUrl: candidate };
  }
  return null;
}

/** Find a catalogue entry's logo: its MCP Registry icons, then its website's brand mark. */
async function resolveRegistryLogo(
  db: ApiDatabase,
  entry: McpRegistryEntry,
): Promise<{ logoId: string; source: ConnectorLogoSource; sourceUrl: string } | null> {
  if (entry.mcpRegistryName) {
    const icons = await mcpRegistryIcons(entry.mcpRegistryName);
    const logoId = await storeFirstIcon(db, icons);
    if (logoId) {
      return {
        logoId,
        source: 'mcp_registry',
        sourceUrl: `${MCP_REGISTRY_API}?search=${entry.mcpRegistryName}`,
      };
    }
  }
  const mark = await websiteBrandMark(db, entry.website);
  return mark ? { ...mark, source: 'website' } : null;
}

/**
 * Read again the logo of every catalogue entry not read in the last week. One
 * entry that cannot be read keeps its previous logo (or stays a monogram); it
 * costs nothing else.
 */
export async function refreshRegistryLogos(db: ApiDatabase, now = new Date()): Promise<void> {
  const stale = new Date(now.getTime() - REGISTRY_LOGO_MAX_AGE_MS);
  const known = await db
    .select({ registryId: mcpRegistryLogos.registryId, refreshedAt: mcpRegistryLogos.refreshedAt })
    .from(mcpRegistryLogos);
  const fresh = new Set(
    known.filter((row) => row.refreshedAt >= stale).map((row) => row.registryId),
  );

  for (const entry of MCP_REGISTRY) {
    if (fresh.has(entry.id)) continue;
    try {
      const found = await resolveRegistryLogo(db, entry);
      if (!found) {
        log.general.warn({ registryId: entry.id }, 'No logo found for a connector');
        continue;
      }
      await db
        .insert(mcpRegistryLogos)
        .values({ registryId: entry.id, ...found, refreshedAt: now })
        .onConflictDoUpdate({
          target: mcpRegistryLogos.registryId,
          set: { ...found, refreshedAt: now },
        });
    } catch (err: unknown) {
      log.general.warn({ err, registryId: entry.id }, 'Connector logo refresh failed');
    }
  }
}

/** Each catalogue entry's logo id. */
export async function registryLogoIds(db: ApiDatabase): Promise<Map<string, string>> {
  const rows = await db
    .select({ registryId: mcpRegistryLogos.registryId, logoId: mcpRegistryLogos.logoId })
    .from(mcpRegistryLogos);
  return new Map(rows.map((row) => [row.registryId, row.logoId]));
}

/** Each catalogue entry's logo id, with where it came from, for the owner and support. */
export async function registryLogoSources(
  db: ApiDatabase,
): Promise<Map<string, { logoId: string; source: ConnectorLogoSource; sourceUrl: string }>> {
  const rows = await db.select().from(mcpRegistryLogos);
  return new Map(
    rows.map((row) => [
      row.registryId,
      { logoId: row.logoId, source: row.source, sourceUrl: row.sourceUrl },
    ]),
  );
}

/** A stored logo, as the API serves it. */
export async function servedLogo(
  db: ApiDatabase,
  id: string,
): Promise<{ contentType: ConnectorLogoType; bytes: Buffer } | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const [row] = await db
    .select({ contentType: connectorLogos.contentType, bytes: connectorLogos.bytes })
    .from(connectorLogos)
    .where(eq(connectorLogos.id, id))
    .limit(1);
  return row ?? null;
}
