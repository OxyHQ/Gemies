/**
 * MCP Tools — the tools of a person's connected MCP connectors, as AI SDK tools.
 *
 * Each connected ACCOUNT is its own connector row, so two Notion workspaces are
 * two sets of tools: `mcp_notion__search` and `mcp_notion_2__search`, each
 * described as `[Notion · <account>] …`. The model chooses the account by the
 * tool it calls, and an agent reaches only the accounts it was granted
 * (`mcp:<id>`, one row at a time); nothing picks an account behind its back.
 *
 * A tool's description is its server's text, offered to the model as it is
 * described: made plain text and cut to `MAX_TOOL_DESCRIPTION` first
 * (`untrustedPlainText`), so nothing invisible or outsized reaches the prompt.
 */

import { integrationsFetch } from '../integrations-client.js';
import { tool, type ToolSet } from 'ai';
import { getDb } from '../../db/index.js';
import {
  listRunnableMcpServersForUser,
  type McpServerRow,
} from '../../db/integrations/mcpServerRepository.js';
import { integrationsConfigFor } from '../mcp-connector-config.js';
import type { McpServerTool } from '../../db/schema/integrations.js';
import { log } from '../logger.js';
import { TTLCache } from '../ttl-cache.js';
import { untrustedPlainText } from '../untrusted-text.js';
import { jsonSchemaToZod } from './mcp-schema.js';

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_TOOL_DESCRIPTION = 1_024;

/** Response shape returned by the integrations service tool-call endpoint. */
interface McpToolCallResult {
  error?: string;
  result?: unknown;
}

// Short-lived per-user cache to avoid a database round trip on every chat
// message. MCP server config changes rarely; 30s staleness is acceptable. The
// selection is part of the key so a one-connector turn can never reuse the
// legacy all-connectors set.
const cache = new TTLCache<ToolSet>({ ttlMs: 30_000, maxSize: 2000 });

/**
 * The MCP tool set of a person's connected connectors, named
 * `mcp_<connector slug>__<tool>`.
 */
export async function buildMcpTools(
  oxyUserId: string,
  /**
   * Which connectors this turn may reach.
   *
   * `undefined` means every connected one: the person's own assistant with no
   * composer selection. An ARRAY names them
   * exactly, and an EMPTY array is a real answer meaning none — which is what an
   * agent granted no connector asks. The pipeline resolves the agent's grants
   * and the composer's per-turn pick into this one value.
   */
  selectedServerIds?: readonly string[],
): Promise<ToolSet> {
  if (selectedServerIds !== undefined && selectedServerIds.length === 0) return {};

  const cacheKey = JSON.stringify({
    oxyUserId,
    selection:
      selectedServerIds === undefined ? { kind: 'all' } : { ids: [...selectedServerIds].sort() },
  });
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const tools: ToolSet = {};

  try {
    if (INTEGRATIONS_URL) {
      const servers = await listRunnableMcpServersForUser(getDb(), oxyUserId, selectedServerIds);

      for (const server of servers) {
        if (!server.tools.length) continue;
        const serverId = server.id;
        const prefix = `mcp_${sanitizeName(server.name)}`;

        for (const mcpTool of server.tools) {
          const toolName = `${prefix}__${sanitizeName(mcpTool.name)}`;
          if (tools[toolName]) {
            log.general.warn({ toolName, serverId }, 'MCP tool name collision, skipping');
            continue;
          }

          tools[toolName] = createServerTool(connectorLabel(server), mcpTool, server, oxyUserId);
        }
      }
    }

    cache.set(cacheKey, tools);

    const toolCount = Object.keys(tools).length;
    if (toolCount > 0) {
      log.general.info({ userId: oxyUserId, toolCount }, 'MCP tools loaded');
    }

    return tools;
  } catch (err) {
    log.general.error({ err, userId: oxyUserId }, 'Failed to load MCP tools');
    return {};
  }
}

/** `Notion · ana@acme.com`: which connector, and which of the person's accounts on it. */
function connectorLabel(server: McpServerRow): string {
  return server.accountLabel
    ? `${server.displayName} · ${server.accountLabel}`
    : server.displayName;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

function createServerTool(
  displayName: string,
  mcpTool: McpServerTool,
  server: McpServerRow,
  oxyUserId: string,
) {
  let inputSchema;
  try {
    inputSchema = jsonSchemaToZod(mcpTool.inputSchema as Record<string, any>);
  } catch {
    inputSchema = jsonSchemaToZod({});
  }

  return tool({
    description: `[${untrustedPlainText(displayName, 120)}] ${
      untrustedPlainText(mcpTool.description, MAX_TOOL_DESCRIPTION) || mcpTool.name
    }`,
    inputSchema,
    execute: async (args: unknown) => {
      return callServerTool(oxyUserId, server, mcpTool.name, args as Record<string, any>);
    },
  });
}

/**
 * One call, carrying what integrations needs to reconnect the connector when
 * its process lost the session (a deploy or a crash) — the row says it is
 * running, so the call reconnects from the stored authorization instead of
 * failing.
 */
async function callServerTool(
  oxyUserId: string,
  server: McpServerRow,
  toolName: string,
  args: Record<string, any>,
): Promise<string> {
  const response = await integrationsFetch(
    oxyUserId,
    `/mcp/servers/${server.id}/tools/${encodeURIComponent(toolName)}/call`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        arguments: args,
        oxyUserId,
        transport: server.transport,
        config: integrationsConfigFor(server),
      }),
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MCP tool call failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as McpToolCallResult;
  if (data.error) {
    throw new Error(data.error);
  }

  return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
}
