/**
 * Connector logos: where each one comes from, and how Gemies keeps it.
 *
 * A logo is read from, in order:
 *
 *  1. **The server itself** — `serverInfo.icons` in its MCP `initialize` answer
 *     (spec 2025-11-25). A provider's server answers `initialize` only with a
 *     token, so for most this is known per connection; a store server that needs
 *     no sign-in publishes it to the catalogue's health check (`storeServerLogo`).
 *  2. **The official MCP Registry** — the `icons` of the entry's `server.json`
 *     (`registry.modelcontextprotocol.io`): a curated entry's record
 *     (`mcpRegistryName`), a synced entry's own listing.
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
  type ConnectorIcon,
  connectorLogos,
  mcpRegistryLogos,
  type ConnectorLogoSource,
  type ConnectorLogoType,
} from '../db/schema/integrations.js';
import { log } from './logger.js';

const FETCH_HEADERS_TIMEOUT_MS = 8_000;
const FETCH_BODY_TIMEOUT_MS = 8_000;
/** A website's HTML is read only as far as its `<head>` needs. */
const MAX_HTML_BYTES = 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; GemiesConnectorLogos/1.0; +https://gemies.ai)';
const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0.1/servers';
/** How long a catalogue logo is trusted before it is read again. */
const REGISTRY_LOGO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
function iconSize(icon: ConnectorIcon): number {
  if (icon.sizes?.includes('any') || icon.mimeType === 'image/svg+xml') return 10_000;
  return Math.max(0, ...(icon.sizes ?? []).map((size) => Number.parseInt(size, 10) || 0));
}

/** The first of these icons that reads as an image, largest first; its stored id or `null`. */
export async function storeFirstIcon(
  db: ApiDatabase,
  icons: readonly ConnectorIcon[],
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
async function mcpRegistryIcons(name: string): Promise<ConnectorIcon[]> {
  const body = await readHttps(
    `${MCP_REGISTRY_API}?search=${encodeURIComponent(name)}&version=latest`,
    MAX_HTML_BYTES,
  );
  if (!body) return [];
  try {
    const listing = JSON.parse(body.toString('utf8')) as {
      servers?: { server?: { name?: string; icons?: ConnectorIcon[] } }[];
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

/**
 * A store entry whose logo is kept: its id, the MCP Registry icons it has (a synced entry's own
 * listing) or the registry name to read them by (a curated entry), and the website whose brand mark
 * is the fallback.
 */
export interface LogoSubject {
  registryId: string;
  icons?: readonly ConnectorIcon[];
  mcpRegistryName?: string;
  website: string;
}

/** Find an entry's logo: its MCP Registry icons, then its website's brand mark. */
async function resolveRegistryLogo(
  db: ApiDatabase,
  subject: LogoSubject,
): Promise<{ logoId: string; source: ConnectorLogoSource; sourceUrl: string } | null> {
  const icons =
    subject.icons ??
    (subject.mcpRegistryName ? await mcpRegistryIcons(subject.mcpRegistryName) : []);
  const logoId = await storeFirstIcon(db, icons);
  if (logoId) {
    const listed = subject.mcpRegistryName ?? subject.registryId.replace(/^mcp_registry:/, '');
    return {
      logoId,
      source: 'mcp_registry',
      sourceUrl: `${MCP_REGISTRY_API}?search=${encodeURIComponent(listed)}`,
    };
  }
  const mark = await websiteBrandMark(db, subject.website);
  return mark ? { ...mark, source: 'website' } : null;
}

async function saveRegistryLogo(
  db: ApiDatabase,
  registryId: string,
  found: { logoId: string; source: ConnectorLogoSource; sourceUrl: string },
  now: Date,
): Promise<void> {
  await db
    .insert(mcpRegistryLogos)
    .values({ registryId, ...found, refreshedAt: now })
    .onConflictDoUpdate({
      target: mcpRegistryLogos.registryId,
      set: { ...found, refreshedAt: now },
    });
}

/**
 * Keep the icon a store server published in its own `initialize` (the health check's answer): the
 * best source there is, so it replaces a registry or website logo.
 */
export async function storeServerLogo(
  db: ApiDatabase,
  registryId: string,
  icons: readonly ConnectorIcon[],
  now = new Date(),
): Promise<void> {
  const logoId = await storeFirstIcon(db, icons);
  if (!logoId) return;
  const sourceUrl = icons.find((icon) => icon.src.startsWith('https://'))?.src ?? 'data:';
  await saveRegistryLogo(db, registryId, { logoId, source: 'server', sourceUrl }, now);
}

/**
 * Read again the logo of every entry not read in the last week, at most `limit` of them a round
 * (a first sync brings hundreds). One entry that cannot be read keeps its previous logo (or stays a
 * monogram); it costs nothing else. A logo its own server published is read again by the health
 * check, never replaced by a registry or website one here.
 */
export async function refreshCatalogueLogos(
  db: ApiDatabase,
  subjects: readonly LogoSubject[],
  { now = new Date(), limit = 150 }: { now?: Date; limit?: number } = {},
): Promise<{ refreshed: number; missing: number }> {
  const stale = new Date(now.getTime() - REGISTRY_LOGO_MAX_AGE_MS);
  const known = await db
    .select({
      registryId: mcpRegistryLogos.registryId,
      source: mcpRegistryLogos.source,
      refreshedAt: mcpRegistryLogos.refreshedAt,
    })
    .from(mcpRegistryLogos);
  const fresh = new Set(
    known
      .filter((row) => row.refreshedAt >= stale || row.source === 'server')
      .map((row) => row.registryId),
  );

  let refreshed = 0;
  let missing = 0;
  for (const subject of subjects.filter((item) => !fresh.has(item.registryId)).slice(0, limit)) {
    try {
      const found = await resolveRegistryLogo(db, subject);
      if (!found) {
        missing += 1;
        continue;
      }
      await saveRegistryLogo(db, subject.registryId, found, now);
      refreshed += 1;
    } catch (err: unknown) {
      log.general.warn({ err, registryId: subject.registryId }, 'Connector logo refresh failed');
    }
  }
  return { refreshed, missing };
}

/** Each catalogue entry's logo id. */
export async function registryLogoIds(db: ApiDatabase): Promise<Map<string, string>> {
  const rows = await db
    .select({ registryId: mcpRegistryLogos.registryId, logoId: mcpRegistryLogos.logoId })
    .from(mcpRegistryLogos);
  return new Map(rows.map((row) => [row.registryId, row.logoId]));
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
