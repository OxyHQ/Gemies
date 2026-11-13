/**
 * Third-party connections: connected messaging accounts, MCP connectors, their
 * logos, and the short-lived MCP OAuth state.
 *
 * One column here is NOT encrypted and holds secrets anyway:
 * `mcp_servers.config_headers` is an arbitrary map a person supplies to reach
 * their own MCP server, and an API key in an `Authorization` header is the
 * ordinary case. It is `jsonb` because its shape belongs to whichever server
 * the person is configuring, so a typed-column allow-list is not available —
 * the projection rule is the defence: never select it into anything a person
 * did not ask for, never log it. The OAuth tokens of every connector live in the
 * integrations service (`mcp_connector_auths`), never here.
 */

import { boolean, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  GEMIE_ACCOUNT_PLATFORMS,
  GEMIE_ACCOUNT_STATUSES,
  type GemieAccountPlatform,
  type GemieAccountStatus,
} from '@gemies/server/internal';
import { agents } from './agents';
import { bytea, checkOneOf } from './columns';

/** Who a gemie answers on an account: everybody who writes, only the chosen chats, or nobody. */
export const CONNECTED_ACCOUNT_REPLIES = ['everyone', 'chosen', 'nobody'] as const;
export type ConnectedAccountReplies = (typeof CONNECTED_ACCOUNT_REPLIES)[number];

/** Whether it answers in a group: never, or when the message mentions or replies to the account. */
export const CONNECTED_ACCOUNT_GROUP_REPLIES = ['never', 'mentions'] as const;
export type ConnectedAccountGroupReplies = (typeof CONNECTED_ACCOUNT_GROUP_REPLIES)[number];

export const MCP_SERVER_SOURCES = ['registry', 'custom'] as const;
export type McpServerSource = (typeof MCP_SERVER_SOURCES)[number];

/**
 * How a connector is reached: always over the network, at an https URL, by the
 * integrations service. A connector that is a command (`stdio`) is not offered:
 * the integrations host is shared by every account and never starts a process.
 */
export const MCP_SERVER_TRANSPORTS = ['sse', 'streamable-http'] as const;
export type McpServerTransport = (typeof MCP_SERVER_TRANSPORTS)[number];

/**
 * `installed` is a custom connector the person added that has not connected yet
 * (its server asks for OAuth, or has not answered); `running` is connected;
 * `error` lost its connection or its authorization, and the person reconnects
 * it. A registry connector has no `installed` row: its row is written when its
 * OAuth completes (`routes/mcp.ts`).
 */
export const MCP_SERVER_STATUSES = ['installed', 'running', 'error'] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

/**
 * Where a connector's logo came from, in the order they are preferred: the
 * server's own `serverInfo.icons` (MCP `initialize`), the official MCP
 * Registry's `server.json` icons, the provider website's brand mark
 * (`lib/connector-logos.ts`). No logo is a monogram the client draws.
 */
export const CONNECTOR_LOGO_SOURCES = ['server', 'mcp_registry', 'website'] as const;
export type ConnectorLogoSource = (typeof CONNECTOR_LOGO_SOURCES)[number];

/**
 * An element of `mcp_servers.tools` / `.resources`.
 *
 * Declared here because the column owns its element shape: `tools[].inputSchema` is
 * JSON Schema the MCP server itself supplies, a format this service does not own
 * and cannot narrow further than `Record<string, unknown>`.
 */
export interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerResource {
  uri: string;
  name: string;
  description?: string;
}

/**
 * A messaging account (WhatsApp, Telegram Business) a person linked to ONE gemie (ADR 0035, 0037).
 *
 * The gemie answers what arrives on it, and only that gemie's turns for that
 * person can see or use it. A session-based link: the integrations service holds
 * the provider session (`session_id`), and the account carries no credential of
 * its own here. Deleting the gemie deletes its accounts (the delete route stops
 * their sessions first: `lib/gemie-accounts.ts`).
 */
export const connectedAccounts = pgTable(
  'connected_accounts',
  {
    id: generatedId(),
    /** The person who linked it, and for whom its gemie answers. An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    /** The gemie it belongs to. */
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    platform: text({ enum: GEMIE_ACCOUNT_PLATFORMS as unknown as [string, ...string[]] })
      .$type<GemieAccountPlatform>()
      .notNull(),
    displayName: text(),
    phoneNumber: text(),
    /** Where its provider session is, in the gateway's own vocabulary (`@gemies/server/internal`). */
    status: text({ enum: GEMIE_ACCOUNT_STATUSES as unknown as [string, ...string[]] })
      .$type<GemieAccountStatus>()
      .notNull()
      .default('qr-pending'),
    /**
     * Whether the platform lets the gemie write from the account: Telegram Business grants it per
     * connection ("Reply to messages"). Null where the platform has no such grant (WhatsApp).
     */
    canReply: boolean(),
    /** Who its gemie answers (ADR 0035): see {@link CONNECTED_ACCOUNT_REPLIES}. */
    replies: text({ enum: CONNECTED_ACCOUNT_REPLIES as unknown as [string, ...string[]] })
      .$type<ConnectedAccountReplies>()
      .notNull()
      .default('everyone'),
    /** The chats it answers when `replies = 'chosen'`, by the platform's chat id. */
    replyChatIds: text().array().notNull().default(sql`'{}'::text[]`),
    groupReplies: text({
      enum: CONNECTED_ACCOUNT_GROUP_REPLIES as unknown as [string, ...string[]],
    })
      .$type<ConnectedAccountGroupReplies>()
      .notNull()
      .default('mentions'),
    /** Durable authority from the verified person who linked this channel. */
    oxyTaskId: text(),
    oxyTaskState: text({ enum: ['active', 'reauth_required'] })
      .notNull()
      .default('reauth_required'),
    sessionId: text(),
    /** When a message last arrived on it. */
    lastActiveAt: timestamptz(),
    connectedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('connected_accounts_oxy_user_id_idx').on(t.oxyUserId),
    index('connected_accounts_session_id_idx').on(t.sessionId),
    index('connected_accounts_agent_user_idx').on(t.agentId, t.oxyUserId),
    checkOneOf('connected_accounts_status_check', t.status, GEMIE_ACCOUNT_STATUSES),
    checkOneOf('connected_accounts_platform_check', t.platform, GEMIE_ACCOUNT_PLATFORMS),
    checkOneOf('connected_accounts_replies_check', t.replies, CONNECTED_ACCOUNT_REPLIES),
    checkOneOf(
      'connected_accounts_group_replies_check',
      t.groupReplies,
      CONNECTED_ACCOUNT_GROUP_REPLIES,
    ),
  ],
);

/**
 * An MCP server a user has installed.
 *
 * `tools` and `resources` are `jsonb`: ordered capability listings read whole
 * when the server is dispatched to, with no cross-table reference and no
 * per-element toggle — the `fallback_events.attempts` shape rather than the
 * `routing_profile_provider_mappings` one. `tools[].inputSchema` is a JSON Schema
 * supplied by the server itself, which is a format this service does not own.
 *
 * `config_headers` and `config_env` hold user-supplied secrets; see the file
 * comment. The rest of `config` has a fixed known shape and becomes columns.
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    /**
     * The connector's slug, unique per person: its tools are `mcp_<name>__<tool>`.
     * A registry connector's first account is its registry id (`notion`), and each
     * further account of the same entry the next free `notion_2`, `notion_3`.
     */
    name: text().notNull(),
    displayName: text().notNull(),
    description: text(),
    /**
     * Which account of the provider this connection is, as the person reads it
     * (`ana@acme.com`, "Work"): the provider's OpenID Connect claims when its
     * token response carries them, otherwise what the person names it.
     */
    accountLabel: text(),
    source: text({ enum: MCP_SERVER_SOURCES as unknown as [string, ...string[]] })
      .$type<McpServerSource>()
      .notNull()
      .default('registry'),
    registryId: text(),
    transport: text({ enum: MCP_SERVER_TRANSPORTS as unknown as [string, ...string[]] })
      .$type<McpServerTransport>()
      .notNull(),
    configUrl: text(),
    /** User-supplied and routinely secret-bearing. Never log; never select by default. */
    configHeaders: jsonb().$type<Record<string, string>>(),
    configRequiresOauth: boolean(),
    status: text({ enum: MCP_SERVER_STATUSES as unknown as [string, ...string[]] })
      .$type<McpServerStatus>()
      .notNull()
      .default('installed'),
    statusMessage: text(),
    tools: jsonb().$type<McpServerTool[]>().notNull().default([]),
    resources: jsonb().$type<McpServerResource[]>(),
    /** The server's own icon (`serverInfo.icons`), stored as we serve it. */
    logoId: text().references(() => connectorLogos.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('mcp_servers_oxy_user_id_idx').on(t.oxyUserId),
    /**
     * One connector per slug per person: the slug names its tools, so two rows
     * with one slug would offer one tool name for two accounts. Connecting a
     * further account picks the next free slug and retries on this index.
     */
    uniqueIndex('mcp_servers_oxy_user_name_key').on(t.oxyUserId, t.name),
    checkOneOf('mcp_servers_source_check', t.source, MCP_SERVER_SOURCES),
    checkOneOf('mcp_servers_transport_check', t.transport, MCP_SERVER_TRANSPORTS),
    checkOneOf('mcp_servers_status_check', t.status, MCP_SERVER_STATUSES),
    check(
      'mcp_servers_registry_check',
      sql`(${t.source} = 'registry') = (${t.registryId} is not null)`,
    ),
  ],
);

/**
 * A connector logo, stored as Gemies serves it (`GET /mcp/logos/:id`), never
 * hot-linked: the app only ever loads a logo from the API's origin.
 *
 * The id is the SHA-256 of the bytes, so a URL names one image for ever and is
 * cached as immutable; two connectors with the same icon share a row. Only
 * images recognized by their bytes, up to `CONNECTOR_LOGO_MAX_BYTES`, are kept
 * (`lib/connector-logos.ts`).
 */
export const CONNECTOR_LOGO_MAX_BYTES = 256 * 1024;
export const CONNECTOR_LOGO_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/svg+xml',
] as const;
export type ConnectorLogoType = (typeof CONNECTOR_LOGO_TYPES)[number];

export const connectorLogos = pgTable(
  'connector_logos',
  {
    /** SHA-256 of `bytes`, hex. */
    id: text().primaryKey(),
    contentType: text({ enum: CONNECTOR_LOGO_TYPES as unknown as [string, ...string[]] })
      .$type<ConnectorLogoType>()
      .notNull(),
    bytes: bytea().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('connector_logos_content_type_check', t.contentType, CONNECTOR_LOGO_TYPES),
    check(
      'connector_logos_size_check',
      sql`octet_length(${t.bytes}) between 1 and ${sql.raw(String(CONNECTOR_LOGO_MAX_BYTES))}`,
    ),
  ],
);

/**
 * The logo of each catalogue entry, before anyone connects it (a provider's
 * server answers `initialize` only with a token). Refreshed by
 * `lib/connector-logos.ts` from the entry's MCP Registry record, then its
 * website; `source_url` is where the bytes were read, for the owner and support.
 */
export const mcpRegistryLogos = pgTable(
  'mcp_registry_logos',
  {
    registryId: text().primaryKey(),
    logoId: text()
      .notNull()
      .references(() => connectorLogos.id, { onDelete: 'cascade' }),
    source: text({ enum: CONNECTOR_LOGO_SOURCES as unknown as [string, ...string[]] })
      .$type<ConnectorLogoSource>()
      .notNull(),
    sourceUrl: text().notNull(),
    refreshedAt: timestamptz().notNull(),
  },
  (t) => [checkOneOf('mcp_registry_logos_source_check', t.source, CONNECTOR_LOGO_SOURCES)],
);

/**
 * How long an abandoned MCP OAuth handshake survives.
 *
 * It lives beside the column it describes, and its two consumers —
 * `db/expiryTargets.ts` for the sweep's retention and `routes/mcp.ts` for the
 * liveness check the callback makes — import it from here. One number, two
 * readers, and the sweep and the check cannot disagree.
 */
export const MCP_OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * The MCP connector's single-use OAuth `state`.
 *
 * TTL: 10 minutes from `created_at` (`MCP_OAUTH_STATE_TTL_SECONDS`). The row is
 * consumed by an atomic delete, so the sweep only ever reaps ABANDONED flows —
 * which is why a retention measured from creation is right here and a deadline
 * column would be redundant.
 *
 * `state` is the credential: whoever presents it recovers the originating user
 * and server. Unique, never logged.
 */
export const mcpOauthStates = pgTable(
  'mcp_oauth_states',
  {
    id: generatedId(),
    state: text().notNull(),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    /**
     * The connector being authorized. For a new account of a registry entry the
     * row does not exist yet: this id is minted at the start and the row is
     * written with it when the flow completes.
     */
    serverId: text().notNull(),
    /** Set when this flow connects a NEW account of this registry entry. */
    registryId: text(),
    /**
     * Where the callback returns the person with `state` and `code`: a page of a
     * Gemies or Alia web origin, or the native app's scheme (`lib/connector-return.ts`).
     */
    returnTo: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_oauth_states_state_key').on(t.state),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('mcp_oauth_states_created_at_idx').on(t.createdAt),
  ],
);
