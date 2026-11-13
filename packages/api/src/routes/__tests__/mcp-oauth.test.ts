// packages/api/src/routes/__tests__/mcp-oauth.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// INTEGRATIONS_URL is captured into a module-level const at import time, so it
// must be present BEFORE mcp.ts is imported. vi.hoisted runs first.
vi.hoisted(() => {
  process.env.INTEGRATIONS_URL = 'http://integrations.test';
  process.env.API_BASE_URL = 'https://api.test';
  process.env.WEB_URL = 'https://gemies.ai';
});

vi.mock('../../db/integrations/mcpServerRepository.js', async () => {
  // `serializeMcpServer` and `toMcpServerConfig` are PURE row transforms and the
  // seam between the flat columns and the wire, so the real ones are kept and
  // only the queries replaced.
  const actual = await vi.importActual<
    typeof import('../../db/integrations/mcpServerRepository.js')
  >('../../db/integrations/mcpServerRepository.js');
  return {
    ...actual,
    findMcpServerForUser: vi.fn(),
    listMcpServersForUser: vi.fn(async () => []),
    insertMcpServer: vi.fn(),
    deleteMcpServerForUser: vi.fn(),
    updateMcpServer: vi.fn(),
    setMcpServerStatus: vi.fn(),
  };
});

vi.mock('../../db/integrations/mcpOAuthStateRepository.js', () => ({
  createMcpOAuthState: vi.fn(),
  findLiveMcpOAuthState: vi.fn(),
  deleteMcpOAuthState: vi.fn(),
  deleteMcpOAuthStateByToken: vi.fn(),
}));

vi.mock('../../db/agents/agentRepository.js', () => ({
  listAgentsGrantedConnectors: vi.fn(async () => []),
}));
vi.mock('../../lib/agent-identity.js', () => ({
  agentPromptName: (identity: { name: string }) => identity.name,
  attachAgentIdentities: vi.fn(async (rows: Record<string, unknown>[]) =>
    rows.map((row) => ({ ...row, name: 'Scout' })),
  ),
}));
vi.mock('../../lib/connector-logos.js', () => ({
  registryLogoIds: vi.fn(async () => new Map([['notion', 'a'.repeat(64)]])),
  storeFirstIcon: vi.fn(async () => 'b'.repeat(64)),
  servedLogo: vi.fn(),
}));

vi.mock('../../lib/integrations-client.js', () => ({
  integrationsFetch: (_account: string, path: string, init: RequestInit) =>
    fetch(`http://integrations.test${path}`, init),
}));
// The handle is never used — every repository call is mocked — but `getDb()`
// throws when Postgres is not connected.
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../lib/mcp-registry.js', () => {
  const MCP_REGISTRY = [
    {
      id: 'notion',
      name: 'Notion',
      description: 'Notion connector',
      category: 'productivity',
      url: 'https://mcp.notion.test/mcp',
      website: 'https://notion.test',
      docsUrl: 'https://notion.test/docs',
      featured: true,
    },
    {
      id: 'vendor',
      name: 'Vendor',
      description: 'A connector whose provider issues Gemies a client',
      category: 'productivity',
      url: 'https://mcp.vendor.test/mcp',
      website: 'https://vendor.test',
      docsUrl: 'https://vendor.test/docs',
      oauth: {
        client: {
          envClientId: 'VENDOR_MCP_CLIENT_ID',
          envClientSecret: 'VENDOR_MCP_CLIENT_SECRET',
        },
        scope: 'read write',
        revocation: { url: 'https://vendor.test/oauth/revoke', clientAuth: 'basic' },
      },
    },
  ];
  return {
    MCP_REGISTRY,
    findRegistryEntry: (id: string) => MCP_REGISTRY.find((entry) => entry.id === id),
  };
});

import {
  deleteMcpServerForUser,
  findMcpServerForUser,
  insertMcpServer,
  listMcpServersForUser,
  setMcpServerStatus,
  updateMcpServer,
  type McpServerRow,
} from '../../db/integrations/mcpServerRepository.js';
import {
  createMcpOAuthState,
  deleteMcpOAuthState,
  deleteMcpOAuthStateByToken,
  findLiveMcpOAuthState,
} from '../../db/integrations/mcpOAuthStateRepository.js';
import { listAgentsGrantedConnectors } from '../../db/agents/agentRepository.js';
import router from '../mcp.js';

const mockFindServer = vi.mocked(findMcpServerForUser);
const mockList = vi.mocked(listMcpServersForUser);
const mockInsert = vi.mocked(insertMcpServer);
const mockSetStatus = vi.mocked(setMcpServerStatus);
const mockDeleteServer = vi.mocked(deleteMcpServerForUser);
const mockUpdate = vi.mocked(updateMcpServer);
const mockCreateState = vi.mocked(createMcpOAuthState);
const mockFindState = vi.mocked(findLiveMcpOAuthState);
const mockDeleteState = vi.mocked(deleteMcpOAuthState);
const mockDeleteStateByToken = vi.mocked(deleteMcpOAuthStateByToken);
const mockGranted = vi.mocked(listAgentsGrantedConnectors);

const USER_A = 'user-a';
const USER_B = 'user-b';

/** A stored connector row, with only the fields a given test cares about set. */
function serverRow(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: 'srv-1',
    oxyUserId: USER_A,
    name: 'notion',
    displayName: 'Notion',
    description: null,
    accountLabel: null,
    source: 'registry',
    registryId: 'notion',
    transport: 'streamable-http',
    configUrl: 'https://mcp.notion.test/mcp',
    configHeaders: null,
    configRequiresOauth: true,
    status: 'running',
    statusMessage: null,
    tools: [],
    resources: null,
    logoId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function stateRow(overrides: Partial<Awaited<ReturnType<typeof findLiveMcpOAuthState>>> = {}) {
  return {
    id: 'state-row-1',
    oxyUserId: USER_A,
    serverId: 'srv-new',
    registryId: 'notion',
    returnTo: 'https://gemies.ai/connectors',
    createdAt: new Date(),
    ...overrides,
  };
}

function getRouteHandler(method: 'get' | 'post' | 'delete' | 'patch', path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route handler found for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any) => Promise<void> | void;
}

function makeMockRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.redirect = vi.fn((url: string) => {
    res.redirectUrl = url;
    return res;
  });
  res.set = vi.fn(() => res);
  res.send = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

function answer(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  mockList.mockResolvedValue([]);
});

/** The body integrations received on its Nth call. */
function sentBody(call = 0) {
  return JSON.parse(mockFetch.mock.calls[call]?.[1]?.body as string);
}

describe('the catalogue', () => {
  it('lists what this deployment can connect, with its logo, and nothing of its configuration', async () => {
    const res = makeMockRes();
    await getRouteHandler('get', '/registry')({}, res);

    expect(res.body.servers).toEqual([
      {
        id: 'notion',
        name: 'Notion',
        description: 'Notion connector',
        category: 'productivity',
        featured: true,
        docsUrl: 'https://notion.test/docs',
        logoUrl: `/mcp/logos/${'a'.repeat(64)}`,
      },
    ]);
  });

  it('lists an entry once its provider client is configured', async () => {
    vi.stubEnv('VENDOR_MCP_CLIENT_ID', 'vendor-id');
    vi.stubEnv('VENDOR_MCP_CLIENT_SECRET', 'vendor-secret');
    const res = makeMockRes();
    await getRouteHandler('get', '/registry')({}, res);

    expect(res.body.servers.map((entry: { id: string }) => entry.id)).toEqual(['notion', 'vendor']);
    expect(JSON.stringify(res.body)).not.toContain('VENDOR_MCP');
  });
});

describe('POST /connect — a new account of a catalogue entry', () => {
  it('starts OAuth for a row that does not exist yet, remembering the entry and where to return', async () => {
    mockFetch.mockResolvedValue(answer({ authorizationUrl: 'https://auth.notion.test/authorize' }));
    const res = makeMockRes();
    await getRouteHandler('post', '/connect')(
      {
        userId: USER_A,
        body: { registryId: 'notion', returnTo: 'https://gemies.ai/connectors?x=1' },
      },
      res,
    );

    expect(res.body).toEqual({ authorizationUrl: 'https://auth.notion.test/authorize' });
    expect(mockInsert).not.toHaveBeenCalled();
    const state = mockCreateState.mock.calls[0]?.[1];
    expect(state).toMatchObject({
      oxyUserId: USER_A,
      registryId: 'notion',
      returnTo: 'https://gemies.ai/connectors',
    });
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      `http://integrations.test/mcp/servers/${state?.serverId}/oauth/start`,
    );
    expect(sentBody()).toMatchObject({
      config: { url: 'https://mcp.notion.test/mcp', requiresOAuth: true },
      callbackUrl: 'https://api.test/mcp/oauth/callback',
    });
  });

  it('never returns to an origin it does not trust', async () => {
    mockFetch.mockResolvedValue(answer({ authorizationUrl: 'https://auth.notion.test/authorize' }));
    await getRouteHandler('post', '/connect')(
      { userId: USER_A, body: { registryId: 'notion', returnTo: 'https://evil.test/steal' } },
      makeMockRes(),
    );
    expect(mockCreateState.mock.calls[0]?.[1].returnTo).toBe('https://gemies.ai/connectors');
  });

  it("returns to the native app's own scheme", async () => {
    mockFetch.mockResolvedValue(answer({ authorizationUrl: 'https://auth.notion.test/authorize' }));
    await getRouteHandler('post', '/connect')(
      { userId: USER_A, body: { registryId: 'notion', returnTo: 'gemies://connectors' } },
      makeMockRes(),
    );
    expect(mockCreateState.mock.calls[0]?.[1].returnTo).toBe('gemies://connectors');
  });

  it('does not start while the provider client is not configured', async () => {
    const res = makeMockRes();
    await getRouteHandler('post', '/connect')(
      { userId: USER_A, body: { registryId: 'vendor' } },
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('not_configured');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends the issued client, scope and revocation endpoint to the catalogue's address", async () => {
    vi.stubEnv('VENDOR_MCP_CLIENT_ID', 'vendor-id');
    vi.stubEnv('VENDOR_MCP_CLIENT_SECRET', 'vendor-secret');
    mockFetch.mockResolvedValue(answer({ authorizationUrl: 'https://auth.vendor.test/authorize' }));
    await getRouteHandler('post', '/connect')(
      { userId: USER_A, body: { registryId: 'vendor' } },
      makeMockRes(),
    );
    expect(sentBody().config).toEqual({
      url: 'https://mcp.vendor.test/mcp',
      requiresOAuth: true,
      oauthClient: { clientId: 'vendor-id', clientSecret: 'vendor-secret' },
      oauthScope: 'read write',
      oauthRevocation: { url: 'https://vendor.test/oauth/revoke', clientAuth: 'basic' },
    });
  });

  it('removes the state when the provider did not start the sign-in', async () => {
    mockFetch.mockResolvedValue(answer({ success: true }));
    const res = makeMockRes();
    await getRouteHandler('post', '/connect')(
      { userId: USER_A, body: { registryId: 'notion' } },
      res,
    );

    expect(res.statusCode).toBe(502);
    expect(mockDeleteStateByToken).toHaveBeenCalled();
  });
});

describe('GET /oauth/callback — public, does not link', () => {
  it('hands state and code to the app that started the flow, and never exchanges', async () => {
    mockFindState.mockResolvedValue(stateRow());
    const res = makeMockRes();
    await getRouteHandler('get', '/oauth/callback')(
      { query: { code: 'the-code', state: 'the-state' } },
      res,
    );

    const url = new URL(res.redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://gemies.ai/connectors');
    expect(url.searchParams.get('mcp_oauth_state')).toBe('the-state');
    expect(url.searchParams.get('mcp_oauth_code')).toBe('the-code');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('says the sign-in expired when the state is unknown', async () => {
    mockFindState.mockResolvedValue(null);
    const res = makeMockRes();
    await getRouteHandler('get', '/oauth/callback')({ query: { code: 'c', state: 'gone' } }, res);
    expect(new URL(res.redirectUrl).searchParams.get('mcp_oauth_error')).toBe('expired');
  });

  it('passes on that the person declined, and forgets the state', async () => {
    mockFindState.mockResolvedValue(stateRow());
    const res = makeMockRes();
    await getRouteHandler('get', '/oauth/callback')(
      { query: { state: 'the-state', error: 'access_denied' } },
      res,
    );
    expect(new URL(res.redirectUrl).searchParams.get('mcp_oauth_error')).toBe('access_denied');
    expect(mockDeleteState).toHaveBeenCalledWith(expect.anything(), 'state-row-1');
  });
});

describe('POST /oauth/complete', () => {
  it('responds 403 and does NOT exchange when state was issued to a different user', async () => {
    mockFindState.mockResolvedValue(stateRow({ oxyUserId: USER_B }));
    const res = makeMockRes();
    await getRouteHandler('post', '/oauth/complete')(
      { userId: USER_A, body: { state: 'the-state', code: 'the-code' } },
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('writes the new account with the id the flow began with, its tools, label and logo', async () => {
    mockFindState.mockResolvedValue(stateRow());
    mockFindServer.mockResolvedValue(null);
    mockInsert.mockImplementation(async (_db, _slug, input) =>
      serverRow({ id: input.id, accountLabel: input.accountLabel ?? null, logoId: input.logoId }),
    );
    mockFetch.mockResolvedValue(
      answer({
        success: true,
        tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        resources: [],
        server: { icons: [{ src: 'https://notion.test/icon.png' }] },
        accountLabel: 'ana@acme.com',
      }),
    );
    const res = makeMockRes();
    await getRouteHandler('post', '/oauth/complete')(
      { userId: USER_A, body: { state: 'the-state', code: 'the-code' } },
      res,
    );

    expect(mockDeleteState).toHaveBeenCalledWith(expect.anything(), 'state-row-1');
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'http://integrations.test/mcp/servers/srv-new/oauth/finish',
    );
    expect(mockInsert).toHaveBeenCalledWith(
      expect.anything(),
      'notion',
      expect.objectContaining({
        id: 'srv-new',
        oxyUserId: USER_A,
        registryId: 'notion',
        accountLabel: 'ana@acme.com',
        status: 'running',
        logoId: 'b'.repeat(64),
      }),
    );
    expect(res.body.server).toMatchObject({
      _id: 'srv-new',
      accountLabel: 'ana@acme.com',
      logoUrl: `/mcp/logos/${'b'.repeat(64)}`,
      config: { url: 'https://mcp.notion.test/mcp', requiresOAuth: true },
    });
  });

  it('names a further account of the same entry when the provider did not', async () => {
    mockFindState.mockResolvedValue(stateRow());
    mockFindServer.mockResolvedValue(null);
    mockList.mockResolvedValue([serverRow()]);
    mockInsert.mockResolvedValue(serverRow({ id: 'srv-new', name: 'notion_2' }));
    mockFetch.mockResolvedValue(answer({ success: true, tools: [], resources: [] }));
    await getRouteHandler('post', '/oauth/complete')(
      { userId: USER_A, body: { state: 'the-state', code: 'the-code' } },
      makeMockRes(),
    );
    expect(mockInsert.mock.calls[0]?.[2].accountLabel).toBe('Account 2');
  });

  it('reconnects an existing account in place', async () => {
    mockFindState.mockResolvedValue(stateRow({ serverId: 'srv-1', registryId: null }));
    mockFindServer.mockResolvedValue(serverRow({ status: 'error' }));
    mockSetStatus.mockResolvedValue(serverRow());
    mockFetch.mockResolvedValue(answer({ success: true, tools: [], resources: [] }));
    const res = makeMockRes();
    await getRouteHandler('post', '/oauth/complete')(
      { userId: USER_A, body: { state: 'the-state', code: 'the-code' } },
      res,
    );

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSetStatus).toHaveBeenCalledWith(expect.anything(), 'srv-1', USER_A, {
      status: 'running',
      statusMessage: null,
      requiresOAuth: true,
      tools: [],
      resources: [],
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /custom — the person’s own server', () => {
  it('connects a server that needs no sign-in', async () => {
    const row = serverRow({
      id: 'srv-c',
      name: 'my_server',
      source: 'custom',
      registryId: null,
      configUrl: 'https://mcp.mine.test/mcp',
      configRequiresOauth: null,
      status: 'installed',
    });
    mockInsert.mockResolvedValue(row);
    mockSetStatus.mockResolvedValue({ ...row, status: 'running' });
    mockFetch.mockResolvedValue(answer({ success: true, tools: [], resources: [] }));
    const res = makeMockRes();
    await getRouteHandler('post', '/custom')(
      { userId: USER_A, body: { name: 'My server', url: 'https://mcp.mine.test/mcp' } },
      res,
    );

    expect(mockInsert).toHaveBeenCalledWith(
      expect.anything(),
      'My server',
      expect.objectContaining({ source: 'custom', config: { url: 'https://mcp.mine.test/mcp' } }),
    );
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://integrations.test/mcp/servers/srv-c/start');
    expect(res.statusCode).toBe(201);
    expect(res.body.authorizationUrl).toBeUndefined();
  });

  it('starts OAuth when the server answers that it wants a token', async () => {
    const row = serverRow({
      id: 'srv-c',
      source: 'custom',
      registryId: null,
      configUrl: 'https://mcp.mine.test/mcp',
      configRequiresOauth: null,
      status: 'installed',
    });
    mockInsert.mockResolvedValue(row);
    mockFetch
      .mockResolvedValueOnce(answer({ code: 'authorization_required' }, 401))
      .mockResolvedValueOnce(answer({ authorizationUrl: 'https://auth.mine.test/authorize' }));
    const res = makeMockRes();
    await getRouteHandler('post', '/custom')(
      { userId: USER_A, body: { name: 'Mine', url: 'https://mcp.mine.test/mcp' } },
      res,
    );

    expect(res.statusCode).toBe(202);
    expect(res.body.authorizationUrl).toBe('https://auth.mine.test/authorize');
    expect(sentBody(1).config).toEqual({ url: 'https://mcp.mine.test/mcp', requiresOAuth: true });
    expect(mockCreateState.mock.calls[0]?.[1]).toMatchObject({ serverId: 'srv-c' });
  });

  it('refuses a server that is not https', async () => {
    const res = makeMockRes();
    await getRouteHandler('post', '/custom')(
      { userId: USER_A, body: { name: 'Mine', url: 'http://mcp.mine.test/mcp' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('refuses a command: every connector is reached over the network', async () => {
    const res = makeMockRes();
    await getRouteHandler('post', '/custom')(
      { userId: USER_A, body: { name: 'Mine', transport: 'stdio', url: 'https://x.test' } },
      res,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /installed — what the person connected', () => {
  it('says which gemies may use each account: Alia every one, others by grant', async () => {
    mockList.mockResolvedValue([serverRow(), serverRow({ id: 'srv-2', name: 'notion_2' })]);
    mockGranted.mockResolvedValue([
      {
        _id: 'gemie-1',
        identity: { source: 'oxy', oxyAccountId: 'acct-1' },
        connectorIds: ['srv-2'],
      },
    ]);
    const res = makeMockRes();
    await getRouteHandler('get', '/installed')({ userId: USER_A }, res);

    const [first, second] = res.body.servers;
    expect(first.usedBy.map((g: { name: string }) => g.name)).toEqual(['Alia']);
    expect(second.usedBy.map((g: { name: string }) => g.name)).toEqual(['Alia', 'Scout']);
    expect(second.usedBy.map((g: { id: string }) => g.id)).toEqual([
      '01a1cf00-cecf-7a24-868b-42b452105a6f',
      'gemie-1',
    ]);
    // A registry connector without its own icon shows its catalogue logo.
    expect(first.logoUrl).toBe(`/mcp/logos/${'a'.repeat(64)}`);
    expect(first.config.headers).toBeUndefined();
  });
});

describe('PATCH /:id', () => {
  it('renames the account', async () => {
    mockFindServer.mockResolvedValue(serverRow());
    mockUpdate.mockResolvedValue(serverRow({ accountLabel: 'Work' }));
    const res = makeMockRes();
    await getRouteHandler('patch', '/:id')(
      { userId: USER_A, params: { id: 'srv-1' }, body: { accountLabel: '  Work ' } },
      res,
    );
    expect(mockUpdate).toHaveBeenCalledWith(expect.anything(), 'srv-1', USER_A, {
      accountLabel: 'Work',
    });
    expect(res.body.server.accountLabel).toBe('Work');
  });

  it("refuses an edit of a catalogue connector's address", async () => {
    mockFindServer.mockResolvedValue(serverRow());
    const res = makeMockRes();
    await getRouteHandler('patch', '/:id')(
      { userId: USER_A, params: { id: 'srv-1' }, body: { config: { url: 'https://evil.test' } } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('answers 404 for a connector of another account', async () => {
    mockFindServer.mockResolvedValue(null);
    const res = makeMockRes();
    await getRouteHandler('patch', '/:id')(
      { userId: USER_B, params: { id: 'srv-1' }, body: { accountLabel: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /:id — disconnect', () => {
  it('asks integrations to revoke, then deletes the row', async () => {
    mockFindServer.mockResolvedValue(serverRow());
    mockDeleteServer.mockResolvedValue(serverRow());
    mockFetch.mockResolvedValue(answer({ success: true }));
    const res = makeMockRes();
    await getRouteHandler('delete', '/:id')({ userId: USER_A, params: { id: 'srv-1' } }, res);

    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://integrations.test/mcp/servers/srv-1/revoke');
    expect(mockDeleteServer).toHaveBeenCalledWith(expect.anything(), 'srv-1', USER_A);
    expect(res.body).toEqual({ success: true });
  });

  it('keeps the row and answers 502 when revocation could not run, so it is retried', async () => {
    mockFindServer.mockResolvedValue(serverRow());
    mockFetch.mockResolvedValue(answer({ error: 'down' }, 500));
    const res = makeMockRes();
    await getRouteHandler('delete', '/:id')({ userId: USER_A, params: { id: 'srv-1' } }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe('revoke_failed');
    expect(mockDeleteServer).not.toHaveBeenCalled();
  });
});
