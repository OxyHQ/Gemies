/**
 * Connectors: the catalogue a person browses, and the accounts they connected.
 *
 * - `GET /mcp/registry` — the catalogue: every provider-hosted MCP server this
 *   deployment can connect, with its logo. An entry whose provider client or
 *   approval is missing is not listed (`isRegistryEntryConfigured`).
 * - `POST /mcp/connect` — connect an account of a catalogue entry. Each call is
 *   a NEW account: its row is written when the OAuth flow completes, so the
 *   connected list never holds a half-made one.
 * - `POST /mcp/custom` — add the person's own remote MCP server by URL.
 * - `GET /mcp/installed` — what the person connected: each account, its status,
 *   its logo and which gemies may use it.
 * - `POST /mcp/:id/reconnect` — authorize an existing account again.
 * - `PATCH /mcp/:id` — rename the account; edit a custom server's address.
 * - `DELETE /mcp/:id` — disconnect: revoke at the provider, then forget.
 * - `GET /mcp/oauth/callback`, `POST /mcp/oauth/complete` — the OAuth return.
 * - `GET /mcp/logos/:id` — a stored logo (`lib/connector-logos.ts`).
 */

import crypto from 'node:crypto';
import express from 'express';
import { integrationsFetch } from '../lib/integrations-client.js';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  deleteMcpServerForUser,
  findMcpServerForUser,
  insertMcpServer,
  listMcpServersForUser,
  serializeMcpServer,
  setMcpServerStatus,
  updateMcpServer,
  type McpServerRow,
} from '../db/integrations/mcpServerRepository.js';
import {
  createMcpOAuthState,
  deleteMcpOAuthState,
  deleteMcpOAuthStateByToken,
  findLiveMcpOAuthState,
} from '../db/integrations/mcpOAuthStateRepository.js';
import { listAgentsGrantedConnectors } from '../db/agents/agentRepository.js';
import type {
  McpServerResource,
  McpServerTool,
  McpServerTransport,
} from '../db/schema/integrations.js';
import { ALIA_GEMIE_ID } from '../domain/alia-gemie.js';
import { agentPromptName, attachAgentIdentities } from '../lib/agent-identity.js';
import {
  registryLogoIds,
  servedLogo,
  storeFirstIcon,
  type McpIcon,
} from '../lib/connector-logos.js';
import {
  connectorReturnTarget,
  connectorReturnUrl,
  defaultConnectorReturn,
} from '../lib/connector-return.js';
import { findRegistryEntry, MCP_REGISTRY, type McpRegistryEntry } from '../lib/mcp-registry.js';
import {
  integrationsConfigFor,
  isRegistryEntryConfigured,
  parseCustomConnector,
  patchedCustomConnector,
  registryIntegrationsConfig,
  type IntegrationsMcpConfig,
} from '../lib/mcp-connector-config.js';
import { log } from '../lib/logger.js';

/** What integrations answers for a connection, as far as this router reads it. */
interface ConnectReply {
  success?: boolean;
  error?: string;
  code?: string;
  authorizationUrl?: unknown;
  tools?: McpServerTool[];
  resources?: McpServerResource[];
  server?: { icons?: McpIcon[] };
  accountLabel?: string;
}

const router = express.Router();

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;
const INTEGRATIONS_TIMEOUT_MS = 30_000;

function callbackUrl(): string {
  return `${process.env.API_BASE_URL || 'http://localhost:4150'}/mcp/oauth/callback`;
}

async function callIntegrations(
  oxyUserId: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = INTEGRATIONS_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; data: ConnectReply }> {
  const response = await integrationsFetch(oxyUserId, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oxyUserId, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await response.json().catch(() => ({}))) as ConnectReply;
  return { ok: response.ok, status: response.status, data };
}

/** A catalogue entry as the store shows it. */
function catalogueEntry(entry: McpRegistryEntry, logos: Map<string, string>) {
  const logoId = logos.get(entry.id);
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    featured: entry.featured ?? false,
    docsUrl: entry.docsUrl,
    logoUrl: logoId ? `/mcp/logos/${logoId}` : null,
  };
}

/** Which of the person's gemies may use each connector: Alia every one, others by grant. */
async function usedByOf(
  oxyUserId: string,
  rows: readonly McpServerRow[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const granted = await listAgentsGrantedConnectors(
    getDb(),
    oxyUserId,
    rows.map((row) => row.id),
  ).catch((err: unknown) => {
    log.general.warn({ err }, 'Could not list the gemies granted connectors');
    return [];
  });
  const named = await attachAgentIdentities(granted);
  const usedBy = new Map<string, { id: string; name: string }[]>();
  for (const row of rows) usedBy.set(row.id, [{ id: ALIA_GEMIE_ID, name: 'Alia' }]);
  for (const agent of named) {
    const name = agentPromptName(agent);
    for (const connectorId of agent.connectorIds) {
      usedBy.get(connectorId)?.push({ id: agent._id, name });
    }
  }
  return usedBy;
}

/**
 * Start an authorization at the provider and answer where the person signs in.
 * `registryId` is set for a NEW account of a catalogue entry, whose row does
 * not exist yet: `serverId` is minted here and the row is written with it on
 * completion.
 */
async function beginAuthorization(input: {
  oxyUserId: string;
  serverId: string;
  registryId?: string;
  transport: McpServerTransport;
  config: IntegrationsMcpConfig;
  returnTo: string;
}): Promise<{ authorizationUrl: string } | { status: number; error: string }> {
  const state = crypto.randomBytes(32).toString('hex');
  const db = getDb();
  await createMcpOAuthState(db, {
    state,
    oxyUserId: input.oxyUserId,
    serverId: input.serverId,
    registryId: input.registryId,
    returnTo: input.returnTo,
  });
  const { ok, status, data } = await callIntegrations(
    input.oxyUserId,
    `/mcp/servers/${input.serverId}/oauth/start`,
    {
      config: input.config,
      transport: input.transport,
      stateToken: state,
      callbackUrl: callbackUrl(),
    },
  );
  if (!ok || typeof data.authorizationUrl !== 'string') {
    // The state is short-lived (TTL), but a start that failed has no use for it.
    await deleteMcpOAuthStateByToken(db, state);
    return {
      status: ok ? 502 : status,
      error: data.error || 'The provider did not start the sign-in',
    };
  }
  return { authorizationUrl: data.authorizationUrl };
}

/** The connector's own icon, stored, when its server published one. */
async function serverLogoId(icons: McpIcon[] | undefined): Promise<string | undefined> {
  if (!icons?.length) return undefined;
  return (await storeFirstIcon(getDb(), icons).catch(() => null)) ?? undefined;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

router.get('/registry', authenticateToken, async (_req, res) => {
  const logos = await registryLogoIds(getDb()).catch(() => new Map<string, string>());
  res.json({
    servers: MCP_REGISTRY.filter((entry) => isRegistryEntryConfigured(entry)).map((entry) =>
      catalogueEntry(entry, logos),
    ),
  });
});

/** A stored logo. Public: its id is its content hash, and a logo is a provider's public mark. */
router.get('/logos/:id', async (req: express.Request<{ id: string }>, res) => {
  const logo = await servedLogo(getDb(), req.params.id).catch(() => null);
  if (!logo) return res.status(404).end();
  res.set({
    'Content-Type': logo.contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // An SVG opened on its own runs nothing and loads nothing.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(logo.bytes);
});

// ---------------------------------------------------------------------------
// OAuth return. The literal routes MUST precede the `/:id` ones.
// ---------------------------------------------------------------------------

// Public: the provider redirects the browser here. It does NOT finalize the link
// (identity from `state` alone would be account-linking CSRF): it hands `state`
// and `code` to the app that started the flow, which finishes with its own
// session in `POST /oauth/complete`.
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const row = typeof state === 'string' ? await findLiveMcpOAuthState(getDb(), state) : null;
  const returnTo = row?.returnTo ?? defaultConnectorReturn();

  if (!row) return res.redirect(connectorReturnUrl(returnTo, { mcp_oauth_error: 'expired' }));
  if (typeof code !== 'string' || !code) {
    // The person declined at the provider, or it refused the request.
    await deleteMcpOAuthState(getDb(), row.id);
    return res.redirect(
      connectorReturnUrl(returnTo, {
        mcp_oauth_error: typeof error === 'string' ? error.slice(0, 64) : 'invalid',
      }),
    );
  }
  // The code is useless without the PKCE verifier integrations holds, so it is
  // safe with the browser that received it; the exchange happens server-side.
  res.redirect(
    connectorReturnUrl(returnTo, { mcp_oauth_state: state as string, mcp_oauth_code: code }),
  );
});

// AUTHENTICATED: the linked account is the caller's, and the state must have
// been issued to this caller.
router.post('/oauth/complete', authenticateToken, async (req, res) => {
  try {
    const { state, code } = req.body ?? {};
    if (typeof state !== 'string' || typeof code !== 'string' || !state || !code) {
      return res.status(400).json({ error: 'state and code are required' });
    }
    const db = getDb();
    const stateRow = await findLiveMcpOAuthState(db, state);
    if (!stateRow) return res.status(400).json({ error: 'Invalid or expired state' });
    if (stateRow.oxyUserId !== req.userId) {
      return res.status(403).json({ error: 'State was not issued to this account' });
    }
    await deleteMcpOAuthState(db, stateRow.id);
    if (!INTEGRATIONS_URL) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }

    const existing = await findMcpServerForUser(db, stateRow.serverId, req.userId!);
    const entry = stateRow.registryId ? findRegistryEntry(stateRow.registryId) : undefined;
    if (!existing && !entry) return res.status(404).json({ error: 'Connector not found' });

    const transport: McpServerTransport = existing?.transport ?? 'streamable-http';
    const config = existing
      ? integrationsConfigFor(existing)
      : registryIntegrationsConfig(entry as McpRegistryEntry);
    const { ok, status, data } = await callIntegrations(
      req.userId!,
      `/mcp/servers/${stateRow.serverId}/oauth/finish`,
      { config, transport, code, callbackUrl: callbackUrl() },
    );
    if (!ok || !data.success) {
      if (existing) {
        await setMcpServerStatus(db, existing.id, req.userId!, {
          status: 'error',
          statusMessage: data.error || 'Sign-in failed',
        });
      }
      return res
        .status(ok ? 502 : status)
        .json({ error: data.error || 'Sign-in failed', code: 'oauth_failed' });
    }

    const logoId = await serverLogoId(data.server?.icons);
    const connected = existing
      ? await setMcpServerStatus(db, existing.id, req.userId!, {
          status: 'running',
          statusMessage: null,
          requiresOAuth: true,
          tools: data.tools ?? [],
          resources: data.resources ?? [],
          ...(data.accountLabel ? { accountLabel: data.accountLabel } : {}),
          ...(logoId ? { logoId } : {}),
        })
      : await insertMcpServer(db, (entry as McpRegistryEntry).id, {
          id: stateRow.serverId,
          oxyUserId: req.userId!,
          displayName: (entry as McpRegistryEntry).name,
          description: (entry as McpRegistryEntry).description,
          accountLabel:
            data.accountLabel ??
            (await defaultAccountLabel(req.userId!, (entry as McpRegistryEntry).id)),
          source: 'registry',
          registryId: (entry as McpRegistryEntry).id,
          transport,
          config: { url: (entry as McpRegistryEntry).url, requiresOAuth: true },
          status: 'running',
          tools: data.tools ?? [],
          resources: data.resources ?? [],
          logoId: logoId ?? null,
        });
    if (!connected) return res.status(409).json({ error: 'This account is already connected' });

    const logos = await registryLogoIds(db).catch(() => new Map<string, string>());
    res.json({
      server: serializeMcpServer(connected, logos.get(connected.registryId ?? '') ?? null),
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'MCP OAuth complete error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * "Account 2" for a further account of an entry whose provider named none: the
 * tools of two accounts must read apart, and the person renames it at will.
 */
async function defaultAccountLabel(oxyUserId: string, registryId: string): Promise<string | null> {
  const others = (await listMcpServersForUser(getDb(), oxyUserId)).filter(
    (row) => row.registryId === registryId,
  );
  return others.length === 0 ? null : `Account ${others.length + 1}`;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

router.post('/connect', authenticateToken, async (req, res) => {
  try {
    const entry =
      typeof req.body?.registryId === 'string' ? findRegistryEntry(req.body.registryId) : undefined;
    if (!entry) return res.status(404).json({ error: 'Connector not found' });
    if (!isRegistryEntryConfigured(entry)) {
      return res
        .status(503)
        .json({ error: `${entry.name} is not available yet`, code: 'not_configured' });
    }
    if (!INTEGRATIONS_URL) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }
    const started = await beginAuthorization({
      oxyUserId: req.userId!,
      serverId: crypto.randomUUID(),
      registryId: entry.id,
      transport: 'streamable-http',
      config: registryIntegrationsConfig(entry),
      returnTo: connectorReturnTarget(req.body?.returnTo),
    });
    if ('error' in started) return res.status(started.status).json({ error: started.error });
    res.json(started);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Connect connector error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Connect a person's own remote MCP server. Without a token first; a server that
 * answers that it wants one starts the OAuth flow, and the answer carries where
 * the person signs in.
 */
router.post('/custom', authenticateToken, async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80) {
      return res.status(400).json({ error: 'name is required (80 characters at most)' });
    }
    const connector = parseCustomConnector(req.body);
    if (!connector.ok) {
      return res.status(400).json({ error: connector.error, code: 'invalid_connector' });
    }
    if (!INTEGRATIONS_URL) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }
    const db = getDb();
    const row = await insertMcpServer(db, name, {
      oxyUserId: req.userId!,
      displayName: name,
      source: 'custom',
      transport: connector.spec.transport,
      config: connector.spec.config,
    });
    if (!row) return res.status(409).json({ error: 'You already have a connector with this name' });
    const outcome = await connectServer(
      req.userId!,
      row,
      connectorReturnTarget(req.body?.returnTo),
    );
    res.status(outcome.authorizationUrl ? 202 : 201).json(outcome);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Add custom connector error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Connect an existing row: a custom server without OAuth connects directly; one
 * that asks for a token, and every catalogue connector, goes through OAuth.
 */
async function connectServer(
  oxyUserId: string,
  row: McpServerRow,
  returnTo: string,
): Promise<{ server: ReturnType<typeof serializeMcpServer>; authorizationUrl?: string }> {
  const db = getDb();
  const logos = await registryLogoIds(db).catch(() => new Map<string, string>());
  const view = (current: McpServerRow) =>
    serializeMcpServer(current, logos.get(current.registryId ?? '') ?? null);

  const authorize = async () => {
    const started = await beginAuthorization({
      oxyUserId,
      serverId: row.id,
      transport: row.transport,
      config: { ...integrationsConfigFor(row), requiresOAuth: true },
      returnTo,
    });
    if ('error' in started) {
      const failed = await setMcpServerStatus(db, row.id, oxyUserId, {
        status: 'error',
        statusMessage: started.error,
      });
      return { server: view(failed ?? row) };
    }
    return { server: view(row), authorizationUrl: started.authorizationUrl };
  };

  if (row.source === 'registry' || row.configRequiresOauth) return authorize();

  const { ok, data } = await callIntegrations(oxyUserId, `/mcp/servers/${row.id}/start`, {
    config: integrationsConfigFor(row),
    transport: row.transport,
  });
  if (!ok && data.code === 'authorization_required') return authorize();
  const logoId = ok ? await serverLogoId(data.server?.icons) : undefined;
  const updated = await setMcpServerStatus(
    db,
    row.id,
    oxyUserId,
    ok
      ? {
          status: 'running',
          statusMessage: null,
          tools: data.tools ?? [],
          resources: data.resources ?? [],
          ...(logoId ? { logoId } : {}),
        }
      : { status: 'error', statusMessage: data.error || 'The server did not answer' },
  );
  return { server: view(updated ?? row) };
}

// ---------------------------------------------------------------------------
// What the person connected
// ---------------------------------------------------------------------------

router.get('/installed', authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const [rows, logos] = await Promise.all([
      listMcpServersForUser(db, req.userId!),
      registryLogoIds(db).catch(() => new Map<string, string>()),
    ]);
    const usedBy = await usedByOf(req.userId!, rows);
    res.json({
      servers: rows.map((row) => ({
        ...serializeMcpServer(row, logos.get(row.registryId ?? '') ?? null),
        usedBy: usedBy.get(row.id) ?? [],
      })),
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'List connectors error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/:id/reconnect',
  authenticateToken,
  async (req: express.Request<{ id: string }>, res) => {
    try {
      const row = await findMcpServerForUser(getDb(), req.params.id, req.userId!);
      if (!row) return res.status(404).json({ error: 'Connector not found' });
      if (!INTEGRATIONS_URL) {
        return res.status(503).json({ error: 'Integrations service not configured' });
      }
      if (row.registryId) {
        const entry = findRegistryEntry(row.registryId);
        if (!entry || !isRegistryEntryConfigured(entry)) {
          return res
            .status(503)
            .json({ error: `${row.displayName} is not available now`, code: 'not_configured' });
        }
      }
      res.json(await connectServer(req.userId!, row, connectorReturnTarget(req.body?.returnTo)));
    } catch (error: unknown) {
      log.general.error({ err: error }, 'Reconnect connector error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/** Rename the account (`accountLabel`); a custom server's `config.url` / `config.headers`. */
router.patch('/:id', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const existing = await findMcpServerForUser(db, req.params.id, req.userId!);
    if (!existing) return res.status(404).json({ error: 'Connector not found' });

    const { accountLabel, config } = req.body ?? {};
    if (
      accountLabel !== undefined &&
      accountLabel !== null &&
      (typeof accountLabel !== 'string' || accountLabel.trim().length > 200)
    ) {
      return res
        .status(400)
        .json({ error: 'accountLabel must be a string of 200 characters at most' });
    }
    let edited: ReturnType<typeof patchedCustomConnector> | undefined;
    if (config !== undefined) {
      if (existing.source !== 'custom') {
        return res.status(400).json({ error: "A catalogue connector's address is the provider's" });
      }
      edited = patchedCustomConnector(existing, config);
      if (!edited.ok)
        return res.status(400).json({ error: edited.error, code: 'invalid_connector' });
    }

    const updated = await updateMcpServer(db, existing.id, req.userId!, {
      ...(edited?.ok ? { config: edited.spec.config } : {}),
      ...(accountLabel === undefined
        ? {}
        : {
            accountLabel:
              typeof accountLabel === 'string' && accountLabel.trim() ? accountLabel.trim() : null,
          }),
    });
    if (!updated) return res.status(404).json({ error: 'Connector not found' });
    const logos = await registryLogoIds(db).catch(() => new Map<string, string>());
    res.json({ server: serializeMcpServer(updated, logos.get(updated.registryId ?? '') ?? null) });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Update connector error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disconnect. The authorization is revoked first — the provider is asked to
// forget the grant and integrations deletes the stored tokens — and the row goes
// only once that answered, so a failed disconnect is retried rather than
// leaving a credential behind for a connector that is gone.
router.delete('/:id', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const existing = await findMcpServerForUser(db, req.params.id, req.userId!);
    if (!existing) return res.status(404).json({ error: 'Connector not found' });

    if (INTEGRATIONS_URL) {
      try {
        const { ok, status } = await callIntegrations(
          req.userId!,
          `/mcp/servers/${existing.id}/revoke`,
          { config: integrationsConfigFor(existing) },
          20_000,
        );
        if (!ok) throw new Error(`revoke answered ${status}`);
      } catch (err: unknown) {
        log.general.warn({ err, serverId: existing.id }, 'MCP revoke failed');
        return res
          .status(502)
          .json({ error: 'Could not disconnect right now. Try again.', code: 'revoke_failed' });
      }
    }

    const removed = await deleteMcpServerForUser(db, existing.id, req.userId!);
    if (!removed) return res.status(404).json({ error: 'Connector not found' });
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Disconnect connector error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
