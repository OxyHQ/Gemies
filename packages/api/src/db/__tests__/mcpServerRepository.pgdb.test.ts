import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { MCP_OAUTH_STATE_TTL_SECONDS, mcpServers } from '../schema/integrations';
import {
  connectorSlug,
  deleteMcpServerForUser,
  findMcpServerForUser,
  insertMcpServer,
  listMcpServersForUser,
  listRunnableMcpServersForUser,
  serializeMcpServer,
  setMcpServerStatus,
  toMcpServerConfig,
  updateMcpServer,
  type NewMcpServer,
} from '../integrations/mcpServerRepository';
import {
  createMcpOAuthState,
  deleteMcpOAuthState,
  deleteMcpOAuthStateByToken,
  findLiveMcpOAuthState,
} from '../integrations/mcpOAuthStateRepository';
import { registryLogoIds, servedLogo, storeLogo } from '../../lib/connector-logos';
import { listAgentsGrantedConnectors } from '../agents/agentRepository';

/**
 * MCP connectors, their logos and their OAuth state, against a REAL server.
 *
 * User ids are prefixed `mcpu-`, and every count is scoped to rows this file
 * inserted — several `*.pgdb.test.ts` files share one database per run.
 */

let db: ApiDatabase;

function newServer(overrides: Partial<NewMcpServer> = {}): NewMcpServer {
  return {
    oxyUserId: 'mcpu-1',
    displayName: 'Notion',
    source: 'registry',
    registryId: 'notion',
    transport: 'streamable-http',
    config: { url: 'https://mcp.notion.test/mcp', requiresOAuth: true },
    ...overrides,
  };
}

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('a person connects several accounts of one connector', () => {
  it('gives each its own slug, so their tools never share a name', async () => {
    const first = await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-multi' }));
    const second = await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-multi' }));
    const third = await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-multi' }));

    expect([first?.name, second?.name, third?.name]).toEqual(['notion', 'notion_2', 'notion_3']);
    expect(await listMcpServersForUser(db, 'mcpu-multi')).toHaveLength(3);
  });

  it('scopes the slug to the person, so two people each have their own `notion`', async () => {
    const a = await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-scope-a' }));
    const b = await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-scope-b' }));
    expect(a?.name).toBe('notion');
    expect(b?.name).toBe('notion');
  });

  it('writes a registry account under the id its OAuth began with, once', async () => {
    const id = crypto.randomUUID();
    const row = await insertMcpServer(db, 'notion', newServer({ id, oxyUserId: 'mcpu-id' }));
    expect(row?.id).toBe(id);
    // A second completion of the same flow is refused rather than a second account.
    expect(await insertMcpServer(db, 'notion', newServer({ id, oxyUserId: 'mcpu-id' }))).toBeNull();
    expect(await listMcpServersForUser(db, 'mcpu-id')).toHaveLength(1);
  });

  it('makes a slug of any name a person gives a custom server', () => {
    expect(connectorSlug('My Server!', 0)).toBe('my_server');
    expect(connectorSlug('My Server!', 1)).toBe('my_server_2');
    expect(connectorSlug('###', 0)).toBe('mcp');
  });
});

/** A write the database refuses with this CHECK. drizzle wraps the error; the name is on its cause. */
function refusedBy(constraint: string) {
  return (error: unknown) => {
    expect(isCheckViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe(constraint);
    return true;
  };
}

describe('the database holds what a connector is', () => {
  it('refuses a command connector: nothing is ever started as a process', async () => {
    await expect(
      db.execute(sql`
        insert into ${mcpServers} (id, oxy_user_id, name, display_name, source, transport)
        values ('mcp-stdio', 'mcpu-stdio', 'x', 'X', 'custom', 'stdio')
      `),
    ).rejects.toSatisfy(refusedBy('mcp_servers_transport_check'));
  });

  it('refuses a registry row without its entry, and a custom row with one', async () => {
    await expect(
      insertMcpServer(db, 'x', newServer({ oxyUserId: 'mcpu-reg', registryId: undefined })),
    ).rejects.toSatisfy(refusedBy('mcp_servers_registry_check'));
    await expect(
      insertMcpServer(db, 'x', newServer({ oxyUserId: 'mcpu-reg', source: 'custom' })),
    ).rejects.toSatisfy(refusedBy('mcp_servers_registry_check'));
  });
});

describe('`config` is flat in the database and nested on both wires', () => {
  it('round-trips through the columns and back into the nested object', async () => {
    const row = await insertMcpServer(
      db,
      'mine',
      newServer({
        oxyUserId: 'mcpu-config',
        source: 'custom',
        registryId: undefined,
        config: { url: 'https://mcp.mine.test/mcp', headers: { Authorization: 'Bearer k' } },
      }),
    );
    if (!row) throw new Error('insert failed');
    expect(toMcpServerConfig(row)).toEqual({
      url: 'https://mcp.mine.test/mcp',
      headers: { Authorization: 'Bearer k' },
    });
    // The headers are the person's secret: never on the wire.
    const served = serializeMcpServer(row);
    expect(served.config).toEqual({ url: 'https://mcp.mine.test/mcp' });
    expect(JSON.stringify(served)).not.toContain('Bearer');
    expect(served._id).toBe(row.id);
  });

  it('merges a patch per key and clears a key sent as null', async () => {
    const row = await insertMcpServer(
      db,
      'mine',
      newServer({
        oxyUserId: 'mcpu-patch',
        source: 'custom',
        registryId: undefined,
        config: { url: 'https://a.test/mcp', headers: { A: '1' } },
      }),
    );
    if (!row) throw new Error('insert failed');
    const urlOnly = await updateMcpServer(db, row.id, 'mcpu-patch', {
      config: { url: 'https://b.test/mcp' },
    });
    expect(toMcpServerConfig(urlOnly!)).toEqual({ url: 'https://b.test/mcp', headers: { A: '1' } });
    const cleared = await updateMcpServer(db, row.id, 'mcpu-patch', {
      config: { headers: undefined },
    });
    expect(toMcpServerConfig(cleared!).headers).toBeUndefined();
    expect(await updateMcpServer(db, row.id, 'mcpu-other', { accountLabel: 'x' })).toBeNull();
  });

  it('renames the account, and answers the current row for an empty patch', async () => {
    const row = await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-label' }));
    if (!row) throw new Error('insert failed');
    expect(
      (await updateMcpServer(db, row.id, 'mcpu-label', { accountLabel: 'Work' }))?.accountLabel,
    ).toBe('Work');
    expect((await updateMcpServer(db, row.id, 'mcpu-label', {}))?.accountLabel).toBe('Work');
  });
});

describe('a status write does not blank what the reply omitted', () => {
  it('keeps the last known tools, and the label, when a reconnect names neither', async () => {
    const row = await insertMcpServer(
      db,
      'notion',
      newServer({
        oxyUserId: 'mcpu-status',
        accountLabel: 'ana@acme.com',
        status: 'running',
        tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
      }),
    );
    if (!row) throw new Error('insert failed');
    const errored = await setMcpServerStatus(db, row.id, 'mcpu-status', {
      status: 'error',
      statusMessage: 'Token expired',
    });
    expect(errored?.tools).toHaveLength(1);
    const back = await setMcpServerStatus(db, row.id, 'mcpu-status', {
      status: 'running',
      statusMessage: null,
    });
    expect(back?.accountLabel).toBe('ana@acme.com');
    expect(back?.statusMessage).toBeNull();
  });
});

describe('the chat tool builder sees only connected accounts', () => {
  it('offers a running connector and not one that lost its connection', async () => {
    const running = await insertMcpServer(
      db,
      'notion',
      newServer({ oxyUserId: 'mcpu-run', status: 'running' }),
    );
    await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-run', status: 'error' }));
    const listed = await listRunnableMcpServersForUser(db, 'mcpu-run');
    expect(listed.map((row) => row.id)).toEqual([running?.id]);
    expect(await listRunnableMcpServersForUser(db, 'mcpu-run', [])).toEqual([]);
  });
});

describe('an id of any shape simply fails to match', () => {
  it("returns null rather than raising, and deletes only the caller's own connector", async () => {
    expect(await findMcpServerForUser(db, 'not-a-uuid', 'mcpu-del')).toBeNull();
    const row = await insertMcpServer(db, 'notion', newServer({ oxyUserId: 'mcpu-del' }));
    if (!row) throw new Error('insert failed');
    expect(await deleteMcpServerForUser(db, row.id, 'mcpu-someone-else')).toBeNull();
    expect((await deleteMcpServerForUser(db, row.id, 'mcpu-del'))?.id).toBe(row.id);
  });
});

describe('a logo is stored once, by its content, and only if it is an image', () => {
  it('keeps a PNG under its hash and serves it back with its type', async () => {
    const id = await storeLogo(db, PNG);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await storeLogo(db, PNG)).toBe(id);
    const served = await servedLogo(db, id!);
    expect(served?.contentType).toBe('image/png');
    expect(served?.bytes.equals(PNG)).toBe(true);
  });

  it('refuses what is not an image, whatever it claims to be', async () => {
    expect(await storeLogo(db, Buffer.from('<html><body>not found</body></html>'))).toBeNull();
    expect(await servedLogo(db, '../etc/passwd')).toBeNull();
  });

  it('falls back to the catalogue logo for a connector without its own', async () => {
    const id = await storeLogo(db, PNG);
    await db.execute(sql`
      insert into mcp_registry_logos (registry_id, logo_id, source, source_url, refreshed_at)
      values ('notion-test', ${id}, 'website', 'https://notion.test/apple-touch-icon.png', now())
      on conflict (registry_id) do nothing
    `);
    expect((await registryLogoIds(db)).get('notion-test')).toBe(id);
  });
});

describe('which gemies were granted a connector', () => {
  it('finds none for connectors nobody was granted', async () => {
    expect(await listAgentsGrantedConnectors(db, 'mcpu-none', ['srv-nobody'])).toEqual([]);
    expect(await listAgentsGrantedConnectors(db, 'mcpu-none', [])).toEqual([]);
  });
});

describe('an OAuth state is a plaintext lookup key with a deadline', () => {
  it('is found by the token it was minted as, with the entry and the return it carries', async () => {
    await createMcpOAuthState(db, {
      state: 'mcp-state-live',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
      registryId: 'notion',
      returnTo: 'https://gemies.ai/connectors',
    });

    const row = await findLiveMcpOAuthState(db, 'mcp-state-live');
    expect(row).toMatchObject({
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
      registryId: 'notion',
      returnTo: 'https://gemies.ai/connectors',
    });
  });

  it('is NOT returned once it is older than the TTL', async () => {
    await createMcpOAuthState(db, {
      state: 'mcp-state-old',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
      returnTo: 'https://gemies.ai/connectors',
    });

    const justInside = new Date(Date.now() + (MCP_OAUTH_STATE_TTL_SECONDS - 5) * 1000);
    expect(await findLiveMcpOAuthState(db, 'mcp-state-old', justInside)).not.toBeNull();

    const pastIt = new Date(Date.now() + (MCP_OAUTH_STATE_TTL_SECONDS + 5) * 1000);
    expect(await findLiveMcpOAuthState(db, 'mcp-state-old', pastIt)).toBeNull();
  });

  it('is consumed by row id, and by token when the authorize never started', async () => {
    await createMcpOAuthState(db, {
      state: 'mcp-state-consume',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
      returnTo: 'https://gemies.ai/connectors',
    });
    const row = await findLiveMcpOAuthState(db, 'mcp-state-consume');
    if (!row) throw new Error('state not found');

    await deleteMcpOAuthState(db, row.id);
    expect(await findLiveMcpOAuthState(db, 'mcp-state-consume')).toBeNull();

    await createMcpOAuthState(db, {
      state: 'mcp-state-abandon',
      oxyUserId: 'mcpu-state',
      serverId: 'srv-x',
      returnTo: 'https://gemies.ai/connectors',
    });
    await deleteMcpOAuthStateByToken(db, 'mcp-state-abandon');
    expect(await findLiveMcpOAuthState(db, 'mcp-state-abandon')).toBeNull();
  });
});
