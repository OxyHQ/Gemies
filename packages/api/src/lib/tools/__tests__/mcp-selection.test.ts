import { beforeEach, describe, expect, it, vi } from 'vitest';

const listRunnableMcpServersForUser = vi.fn();

vi.stubEnv('INTEGRATIONS_URL', 'https://integrations.example.test');
vi.mock('../../integrations-client.js', () => ({
  integrationsFetch: (_account: string, path: string, init: RequestInit) =>
    fetch(`https://integrations.example.test${path}`, init),
}));

vi.mock('ai', () => ({ tool: (definition: unknown) => definition }));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({ marker: 'db' }) }));
vi.mock('../../../db/integrations/mcpServerRepository.js', () => ({
  listRunnableMcpServersForUser: (...args: unknown[]) => listRunnableMcpServersForUser(...args),
}));
vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../mcp-schema.js', () => ({ jsonSchemaToZod: () => ({}) }));

const { buildMcpTools } = await import('../mcp.js');

const search = { name: 'search', description: 'Search', inputSchema: {} };

/** Two accounts of one catalogue connector, and a custom one. */
const notionWork = {
  id: 'server-notion',
  name: 'notion',
  displayName: 'Notion',
  accountLabel: 'ana@acme.com',
  tools: [search],
};
const notionHome = {
  id: 'server-notion-2',
  name: 'notion_2',
  displayName: 'Notion',
  accountLabel: 'Home',
  tools: [search],
};
const custom = {
  id: 'server-custom',
  name: 'hosted-app',
  displayName: 'Hosted App',
  accountLabel: null,
  tools: [search],
};

beforeEach(() => {
  vi.clearAllMocks();
  listRunnableMcpServersForUser.mockResolvedValue([notionWork, notionHome, custom]);
});

describe('per-turn MCP selection', () => {
  it('uses an EMPTY selection as an explicit deny without reading connector state', async () => {
    // What an agent granted no connector asks. Distinct from `undefined`, which
    // is every connected one — the two are one keystroke apart and mean the
    // opposite, so the source answers the empty case before it builds anything.
    expect(await buildMcpTools('user-none', [])).toEqual({});
    expect(listRunnableMcpServersForUser).not.toHaveBeenCalled();
  });

  it('passes the named ids to the repository', async () => {
    listRunnableMcpServersForUser.mockResolvedValue([custom]);
    const tools = await buildMcpTools('user-selected', ['server-custom']);

    expect(Object.keys(tools)).toEqual(['mcp_hosted_app__search']);
    expect(listRunnableMcpServersForUser).toHaveBeenCalledWith({ marker: 'db' }, 'user-selected', [
      'server-custom',
    ]);
  });

  it('does not reuse an all-connectors cache entry for a selected turn', async () => {
    await buildMcpTools('user-cache');
    await buildMcpTools('user-cache', ['server-custom']);

    expect(listRunnableMcpServersForUser).toHaveBeenCalledTimes(2);
  });
});

describe('two accounts of one connector', () => {
  it('are two sets of tools, each naming its account, so the model chooses which', async () => {
    const tools = await buildMcpTools('user-accounts');

    expect(Object.keys(tools).sort()).toEqual([
      'mcp_hosted_app__search',
      'mcp_notion_2__search',
      'mcp_notion__search',
    ]);
    const described = (name: string) => (tools[name] as { description: string }).description;
    expect(described('mcp_notion__search')).toBe('[Notion · ana@acme.com] Search');
    expect(described('mcp_notion_2__search')).toBe('[Notion · Home] Search');
    expect(described('mcp_hosted_app__search')).toBe('[Hosted App] Search');
  });
});
