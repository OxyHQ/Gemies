/**
 * What a connector is, and the config the integrations service receives for it.
 *
 * Every connector is REMOTE: integrations reaches it at an https URL over
 * streamable HTTP (or SSE, for a custom server that still speaks it), and judges
 * that URL's address, and every address its server points at afterwards, on each
 * connection (`packages/integrations/src/mcp/connector-fetch.ts`). Nothing a
 * person names is ever started as a process.
 *
 * ## A registry connector is the registry's
 *
 * A connector from the catalogue is reached at the catalogue's address with the
 * catalogue's OAuth settings, whatever its row says, so an edited URL never
 * receives a client secret Gemies holds for a provider. A custom connector is
 * the person's: its URL and headers.
 */

import { z } from 'zod';
import {
  toMcpServerConfig,
  type McpServerConfig,
  type McpServerRow,
} from '../db/integrations/mcpServerRepository.js';
import { MCP_SERVER_TRANSPORTS, type McpServerTransport } from '../db/schema/integrations.js';
import { connectorCallbackUrl } from './connector-return.js';
import { findRegistryEntry, type McpRegistryEntry } from './mcp-registry.js';

export interface IntegrationsMcpConfig extends McpServerConfig {
  /** Where the provider returns an authorization (`connectorCallbackUrl`): one URI, from the API. */
  oauthCallbackUrl: string;
  oauthClient?: { clientId: string; clientSecret?: string };
  oauthScope?: string;
  oauthRevocation?: { url: string; clientAuth: 'basic' | 'body' };
}

const stringMap = z.record(z.string(), z.string());

const httpsUrl = z
  .string()
  .trim()
  .refine((url) => URL.canParse(url) && new URL(url).protocol === 'https:', 'must be an https URL');

/** What a person sets on a custom connector. */
const customConnector = z.object({
  transport: z.enum(MCP_SERVER_TRANSPORTS).default('streamable-http'),
  url: httpsUrl,
  headers: stringMap.optional(),
});

export interface CustomConnectorSpec {
  transport: McpServerTransport;
  config: Required<Pick<McpServerConfig, 'url'>> & Pick<McpServerConfig, 'headers'>;
}

export type CustomConnectorResult =
  | { ok: true; spec: CustomConnectorSpec }
  | { ok: false; error: string };

function refusal(error: z.ZodError): { ok: false; error: string } {
  const issue = error.issues[0];
  const where = issue?.path.length ? issue.path.join('.') : 'connector';
  return { ok: false, error: `${where}: ${issue?.message ?? 'invalid'}` };
}

/** A custom connector a person describes: its address and, optionally, the headers it needs. */
export function parseCustomConnector(input: unknown): CustomConnectorResult {
  const parsed = customConnector.safeParse(input ?? {});
  if (!parsed.success) return refusal(parsed.error);
  const { transport, url, headers } = parsed.data;
  return { ok: true, spec: { transport, config: { url, ...(headers ? { headers } : {}) } } };
}

/** A custom connector with a person's edit applied, validated as a whole. A key sent as `null` clears it. */
export function patchedCustomConnector(row: McpServerRow, patch: unknown): CustomConnectorResult {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'config must be an object' };
  }
  const edit = patch as Record<string, unknown>;
  const stored = toMcpServerConfig(row);
  return parseCustomConnector({
    transport: row.transport,
    url: Object.hasOwn(edit, 'url') ? edit.url : stored.url,
    headers: Object.hasOwn(edit, 'headers') ? (edit.headers ?? undefined) : stored.headers,
  });
}

export function registryEntryOf(row: Pick<McpServerRow, 'source' | 'registryId'>) {
  if (row.source !== 'registry' || !row.registryId) return undefined;
  return findRegistryEntry(row.registryId);
}

/**
 * The pre-registered client for an entry, read from the environment now. `null`
 * means the entry needs one and it is not configured; `undefined` means the
 * entry uses Dynamic Client Registration.
 */
function registryOAuthClient(
  entry: McpRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret?: string } | null | undefined {
  const client = entry.oauth?.client;
  if (!client) return undefined;
  const clientId = env[client.envClientId]?.trim();
  if (!clientId) return null;
  if (!client.envClientSecret) return { clientId };
  const clientSecret = env[client.envClientSecret]?.trim();
  if (!clientSecret) return null;
  return { clientId, clientSecret };
}

/** Whether a catalogue entry can be connected with this deployment's configuration. */
export function isRegistryEntryConfigured(
  entry: McpRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const gate = entry.oauth?.enabledBy;
  if (gate && env[gate]?.trim().toLowerCase() !== 'true') return false;
  return registryOAuthClient(entry, env) !== null;
}

/** The config integrations reaches a catalogue entry with: always OAuth, at the catalogue's address. */
export function registryIntegrationsConfig(
  entry: McpRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationsMcpConfig {
  const client = registryOAuthClient(entry, env);
  return {
    url: entry.url,
    requiresOAuth: true,
    oauthCallbackUrl: connectorCallbackUrl(env),
    ...(client ? { oauthClient: client } : {}),
    ...(entry.oauth?.scope ? { oauthScope: entry.oauth.scope } : {}),
    ...(entry.oauth?.revocation ? { oauthRevocation: entry.oauth.revocation } : {}),
  };
}

export function integrationsConfigFor(
  row: McpServerRow,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationsMcpConfig {
  const entry = registryEntryOf(row);
  return entry
    ? registryIntegrationsConfig(entry, env)
    : { ...toMcpServerConfig(row), oauthCallbackUrl: connectorCallbackUrl(env) };
}
