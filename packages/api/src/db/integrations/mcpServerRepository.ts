/**
 * Installed MCP connectors, on Postgres.
 *
 * ## `config` is FLAT in the database and NESTED on both wires
 *
 * `config` is stored flat as `config_url`, `config_headers` and
 * `config_requires_oauth`. Two consumers still need the nested object and
 * neither can be changed from here:
 *
 *  - **`packages/integrations`** receives `{ config }` verbatim in the body of
 *    every `/mcp/servers/:id/{start,stop,oauth/start,oauth/finish}` call. It is
 *    a separate service with its own deploy.
 *  - **the shipped mobile builds** read `server.config.url`,
 *    `server.config.requiresOAuth` off the API response, and the row's id as
 *    **`_id`**. A shipped build cannot be recalled.
 *
 * So `toMcpServerConfig` and `serializeMcpServer` are the two seams that keep
 * the stored shape and the wire shape apart, and they live here beside the
 * columns rather than in the route, because getting one of them wrong is a
 * silent `undefined` on the far side rather than an error. `_id` is served
 * ALONGSIDE `id`.
 *
 * `config_headers` holds user-supplied secrets — an API key in an
 * `Authorization` header is the ordinary case. It is projected only into the
 * integrations body, never into a response, and never logged.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  mcpServers,
  type McpServerResource,
  type McpServerSource,
  type McpServerStatus,
  type McpServerTool,
  type McpServerTransport,
} from '../schema/integrations';

/** A connector row as stored. */
export type McpServerRow = typeof mcpServers.$inferSelect;

/** The nested `config` both wires expect. */
export interface McpServerConfig {
  url?: string;
  headers?: Record<string, string>;
  requiresOAuth?: boolean;
}

/**
 * Reassemble the nested `config` from the flat columns.
 *
 * A `null` column becomes an ABSENT key rather than `null`, because that is what
 * the integrations service's `??`-style defaults are written against. `{ url: null }` and `{}`
 * are the same to a `if (config.url)` and different to a `Object.keys` count or
 * a JSON body a strict schema validates.
 */
export function toMcpServerConfig(row: McpServerRow): McpServerConfig {
  return {
    ...(row.configUrl === null ? {} : { url: row.configUrl }),
    ...(row.configHeaders === null ? {} : { headers: row.configHeaders }),
    ...(row.configRequiresOauth === null ? {} : { requiresOAuth: row.configRequiresOauth }),
  };
}

/**
 * The connector as the API serves it. `config` carries only what the person may
 * read back: its URL and whether it authorizes over OAuth, never its headers.
 * `logoUrl` is a path on the API's own origin (`GET /mcp/logos/:id`), or `null`
 * for a monogram.
 */
export interface SerializedMcpServer {
  _id: string;
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  accountLabel: string | null;
  source: McpServerSource;
  registryId: string | null;
  transport: McpServerTransport;
  config: Pick<McpServerConfig, 'url' | 'requiresOAuth'>;
  status: McpServerStatus;
  statusMessage: string | null;
  tools: McpServerTool[];
  resources: McpServerResource[] | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Row -> the response body. The logo is the server's own when it published one,
 * else its catalogue entry's (`registryLogoId`, read by the caller).
 *
 * `oxy_user_id` is deliberately absent: it is the scope every query already
 * filters on, so echoing it back tells the caller only what they asked with.
 */
export function serializeMcpServer(
  row: McpServerRow,
  registryLogoId: string | null = null,
): SerializedMcpServer {
  const logoId = row.logoId ?? registryLogoId;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    accountLabel: row.accountLabel,
    source: row.source,
    registryId: row.registryId,
    transport: row.transport,
    config: {
      ...(row.configUrl === null ? {} : { url: row.configUrl }),
      ...(row.configRequiresOauth === null ? {} : { requiresOAuth: row.configRequiresOauth }),
    },
    status: row.status,
    statusMessage: row.statusMessage,
    tools: row.tools,
    resources: row.resources,
    logoUrl: logoId ? connectorLogoPath(logoId) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Where the API serves a stored logo. Its id is its content hash, so the path is immutable. */
export function connectorLogoPath(logoId: string): string {
  return `/mcp/logos/${logoId}`;
}

/**
 * One connector belonging to this user, or `null`.
 *
 * Six routes take this path and all six are scoped by `oxyUserId` — an id alone must not reach another account's connector.
 *
 * `id` is `text`, so an id of any shape simply fails to match and the caller
 * gets a 404 — pinned by a test, because a quiet answer is worth a test whichever
 * way it points.
 */
export async function findMcpServerForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<McpServerRow | null> {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .limit(1);

  return row ?? null;
}

/** Every connector this user has installed, newest first. */
export async function listMcpServersForUser(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<McpServerRow[]> {
  return db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.oxyUserId, oxyUserId))
    .orderBy(desc(mcpServers.createdAt));
}

export interface NewMcpServer {
  /** Minted by the caller for a registry connection, whose OAuth began before the row exists. */
  readonly id?: string | undefined;
  readonly oxyUserId: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly accountLabel?: string | null | undefined;
  readonly source: McpServerSource;
  readonly registryId?: string | undefined;
  readonly transport: McpServerTransport;
  readonly config: McpServerConfig;
  readonly status?: McpServerStatus | undefined;
  readonly tools?: McpServerTool[] | undefined;
  readonly resources?: McpServerResource[] | undefined;
  readonly logoId?: string | null | undefined;
}

/** The slugs a connector named `base` may take, in order: `notion`, `notion_2`, `notion_3`… */
export function connectorSlug(base: string, attempt: number): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'mcp';
  return attempt === 0 ? slug : `${slug}_${attempt + 1}`;
}

/** How many slugs an install tries before giving up: more accounts of one connector than anyone has. */
const MAX_SLUG_ATTEMPTS = 50;

/**
 * Add a connector under the first free slug of `slugBase` (`mcp_servers_oxy_user_name_key`
 * decides, not a read-then-write race), or answer `null` when every slug is taken
 * or a row with this id already exists.
 *
 * `ON CONFLICT DO NOTHING` rather than a caught error: a thrown constraint
 * violation aborts a surrounding transaction and the next attempt with it.
 */
export async function insertMcpServer(
  db: ApiDatabase,
  slugBase: string,
  input: NewMcpServer,
): Promise<McpServerRow | null> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const [row] = await db
      .insert(mcpServers)
      .values({
        ...(input.id ? { id: input.id } : {}),
        oxyUserId: input.oxyUserId,
        name: connectorSlug(slugBase, attempt),
        displayName: input.displayName,
        description: input.description ?? null,
        accountLabel: input.accountLabel ?? null,
        source: input.source,
        registryId: input.registryId ?? null,
        transport: input.transport,
        configUrl: input.config.url ?? null,
        configHeaders: input.config.headers ?? null,
        configRequiresOauth: input.config.requiresOAuth ?? null,
        status: input.status ?? 'installed',
        tools: input.tools ?? [],
        resources: input.resources ?? null,
        logoId: input.logoId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    if (input.id) {
      const [taken] = await db
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.id))
        .limit(1);
      if (taken) return null;
    }
  }
  return null;
}

/** Remove a connector belonging to this user, returning what was removed. */
export async function deleteMcpServerForUser(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<McpServerRow | null> {
  const [row] = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .returning();

  return row ?? null;
}

/** What `PATCH /mcp/:id` may change: a custom connector's address, and any connector's account label. */
export interface McpServerPatch {
  readonly config?: Pick<McpServerConfig, 'url' | 'headers'> | undefined;
  readonly accountLabel?: string | null | undefined;
}

/**
 * Apply a patch and return the updated row.
 *
 * `config` merges per KEY, because the columns are flat: a key the caller did
 * not send keeps its stored value; a key sent as `null` clears it. JSON cannot
 * carry `undefined`, so `in` is what tells the two apart.
 */
export async function updateMcpServer(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
  patch: McpServerPatch,
): Promise<McpServerRow | null> {
  const set: Partial<typeof mcpServers.$inferInsert> = {};

  if (patch.config !== undefined) {
    const c = patch.config;
    if ('url' in c) set.configUrl = c.url ?? null;
    if ('headers' in c) set.configHeaders = c.headers ?? null;
  }
  if (patch.accountLabel !== undefined) set.accountLabel = patch.accountLabel;

  // An empty patch is a legitimate request, and `db.update()` with no columns
  // is a syntax error: answer with the current row rather than raising.
  if (Object.keys(set).length === 0) return findMcpServerForUser(db, id, oxyUserId);

  const [row] = await db
    .update(mcpServers)
    .set(set)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .returning();

  return row ?? null;
}

/** What a connect or OAuth-finish outcome records. */
export interface McpServerStatusPatch {
  readonly status: McpServerStatus;
  readonly statusMessage?: string | null | undefined;
  readonly tools?: McpServerTool[] | undefined;
  readonly resources?: McpServerResource[] | undefined;
  readonly requiresOAuth?: boolean | undefined;
  /** Written only when the provider named the account (a reconnect keeps the person's label otherwise). */
  readonly accountLabel?: string | undefined;
  /** The server's own icon, when it published one. */
  readonly logoId?: string | undefined;
}

/**
 * Record what became of a connector after a call to the integrations service.
 *
 * `tools` and `resources` are only written when the response CARRIED them —
 * `if (data.tools) server.tools = data.tools` in the source — so an integrations
 * reply that omits them leaves the last known capability listing in place rather
 * than blanking it. Spread rather than `?? null` for the same reason the event
 * log spreads `agentSessionId`.
 */
export async function setMcpServerStatus(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
  patch: McpServerStatusPatch,
): Promise<McpServerRow | null> {
  const [row] = await db
    .update(mcpServers)
    .set({
      status: patch.status,
      ...(patch.statusMessage === undefined ? {} : { statusMessage: patch.statusMessage }),
      ...(patch.tools === undefined ? {} : { tools: patch.tools }),
      ...(patch.resources === undefined ? {} : { resources: patch.resources }),
      ...(patch.requiresOAuth === undefined ? {} : { configRequiresOauth: patch.requiresOAuth }),
      ...(patch.accountLabel === undefined ? {} : { accountLabel: patch.accountLabel }),
      ...(patch.logoId === undefined ? {} : { logoId: patch.logoId }),
    })
    .where(and(eq(mcpServers.id, id), eq(mcpServers.oxyUserId, oxyUserId)))
    .returning();

  return row ?? null;
}

/**
 * The connectors the chat tool builder dispatches to: the connected ones. One
 * that is not `running` would answer every tool call with a connection error.
 */
export async function listRunnableMcpServersForUser(
  db: ApiDatabase,
  oxyUserId: string,
  /**
   * The connectors this turn may use, or `undefined` for every runnable one.
   *
   * An EMPTY array is a real answer — "these zero connectors" — and returns
   * nothing rather than everything. It is what an agent granted no connector
   * asks, and `inArray(col, [])` is a shape drizzle has changed its handling
   * of, so the empty case is answered before a statement is built.
   */
  selectedServerIds?: readonly string[],
): Promise<McpServerRow[]> {
  if (selectedServerIds !== undefined && selectedServerIds.length === 0) return [];
  return db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.oxyUserId, oxyUserId),
        eq(mcpServers.status, 'running'),
        ...(selectedServerIds === undefined
          ? []
          : [inArray(mcpServers.id, [...selectedServerIds])]),
      ),
    );
}
