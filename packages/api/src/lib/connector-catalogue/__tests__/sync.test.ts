import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({ log: { general: { info: vi.fn(), warn: vi.fn() } } }));
vi.mock('../../../db/integrations/mcpCatalogueRepository.js', () => ({
  getCatalogueSyncState: vi.fn(async () => null),
  insertCatalogueRows: vi.fn(async () => undefined),
  listCatalogueRowsOfSource: vi.fn(async () => []),
  markCatalogueRowsRemoved: vi.fn(async () => undefined),
  recordCatalogueSyncFailure: vi.fn(async () => undefined),
  recordCatalogueSyncSuccess: vi.fn(async () => undefined),
  updateCatalogueRow: vi.fn(async () => undefined),
}));

const repository = await import('../../../db/integrations/mcpCatalogueRepository.js');
const { listedFromRegistry } = await import('../official-registry.js');
const { CatalogueRateLimitError } = await import('../policy.js');
const { syncCatalogueSources, syncConnectorCatalogue } = await import('../sync.js');
const { listedFromDocker } = await import('../docker-catalogue.js');
const { candidateOf } = await import('../policy.js');

type Pass = Awaited<ReturnType<typeof import('../official-registry.js').readOfficialRegistry>>;

function server(name: string, url: string, extra: Record<string, unknown> = {}) {
  return listedFromRegistry({
    server: { name, version: '1.0.0', remotes: [{ type: 'streamable-http', url }], ...extra },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
  });
}

const curated = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Notion',
    category: 'productivity' as const,
    url: 'https://mcp.notion.com/mcp',
    website: 'https://notion.com',
    mcpRegistryName: 'com.notion/mcp',
    docsUrl: 'https://notion.com/docs',
  },
];

const now = new Date('2026-11-13T12:00:00Z');

function storedRowOf(listed: ReturnType<typeof server>) {
  const read = candidateOf(listed);
  if (!read.ok) throw new Error('expected a candidate');
  return {
    ...read.candidate,
    source: 'mcp_registry',
    removedAt: null,
    health: 'healthy',
    auth: 'none',
    consecutiveFailures: 0,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('a sync of the official MCP Registry', () => {
  it('inserts new servers, leaves the curated ones and keeps one listing per endpoint', async () => {
    const pass: Pass = {
      malformed: 1,
      servers: [
        server('com.weather/mcp', 'https://mcp.weather.com/mcp'),
        server('io.github.copy/weather', 'https://mcp.weather.com/mcp/'),
        server('com.notion/mcp', 'https://mcp.notion.com/mcp'),
        server('io.github.other/notion-proxy', 'https://mcp.notion.com/mcp'),
        listedFromRegistry({ server: { name: 'io.github.pkg/local', version: '1.0.0' } }),
      ] as never,
    };
    const outcome = await syncConnectorCatalogue({} as never, {
      read: async () => pass,
      curated,
      overrides: {},
      now,
    });

    expect(outcome).toEqual({
      status: 'synced',
      report: {
        listed: 6,
        candidates: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        removed: 0,
        refused: { malformed: 1, duplicate: 1, curated: 2, no_remote: 1 },
      },
    });
    const inserted = vi.mocked(repository.insertCatalogueRows).mock.calls[0]?.[1];
    expect(inserted?.map((row) => [row.id, row.trust])).toEqual([
      ['mcp_registry:com.weather/mcp', 'official'],
    ]);
  });

  it('updates a changed listing, checks a moved one again, and removes what is gone', async () => {
    const kept = server('com.weather/mcp', 'https://mcp.weather.com/mcp');
    const moved = server('com.maps/mcp', 'https://mcp.maps.com/mcp');
    const gone = server('com.gone/mcp', 'https://mcp.gone.com/mcp');
    vi.mocked(repository.listCatalogueRowsOfSource).mockResolvedValue([
      storedRowOf(kept),
      storedRowOf(moved),
      storedRowOf(gone),
    ] as never);
    const outcome = await syncConnectorCatalogue({} as never, {
      read: async () => ({
        malformed: 0,
        servers: [kept, server('com.maps/mcp', 'https://v2.maps.com/mcp')] as never,
      }),
      curated,
      overrides: {},
      now,
    });

    expect(outcome).toMatchObject({ report: { unchanged: 1, updated: 1, removed: 1 } });
    expect(repository.updateCatalogueRow).toHaveBeenCalledWith(
      expect.anything(),
      'mcp_registry:com.maps/mcp',
      expect.objectContaining({
        url: 'https://v2.maps.com/mcp',
        health: 'pending',
        auth: 'unknown',
      }),
    );
    expect(repository.markCatalogueRowsRemoved).toHaveBeenCalledWith(
      expect.anything(),
      ['mcp_registry:com.gone/mcp'],
      now,
    );
  });

  it('leaves out a listing farm whole, unless the operator admits its publisher', async () => {
    const farm = Array.from({ length: 26 }, (_, index) =>
      server(`io.github.farm/city-${index}`, `https://farm.example.com/city/${index}`),
    );
    const read = async () => ({ malformed: 0, servers: farm as never });
    const refused = await syncConnectorCatalogue({} as never, {
      read,
      curated,
      overrides: {},
      now,
    });
    expect(refused).toMatchObject({ report: { candidates: 0, refused: { bulk_publisher: 26 } } });

    const admitted = await syncConnectorCatalogue({} as never, {
      read,
      curated,
      overrides: { 'publisher:io.github.farm': { allowBulk: true } },
      now,
    });
    expect(admitted).toMatchObject({ report: { candidates: 26, created: 26 } });
  });

  it('changes nothing when the pass fails, and keeps when to come back after a rate limit', async () => {
    const retryAt = new Date('2026-11-13T13:00:00Z');
    const outcome = await syncConnectorCatalogue({} as never, {
      read: async () => {
        throw new CatalogueRateLimitError(retryAt, 'The MCP Registry');
      },
      curated,
      now,
    });
    expect(outcome).toMatchObject({ status: 'failed', retryAt });
    expect(repository.recordCatalogueSyncFailure).toHaveBeenCalledWith(
      expect.anything(),
      'mcp_registry',
      expect.any(String),
      retryAt,
      now,
    );
    expect(repository.markCatalogueRowsRemoved).not.toHaveBeenCalled();
    expect(repository.insertCatalogueRows).not.toHaveBeenCalled();
  });

  it('takes from Docker only what the official registry does not already list', async () => {
    vi.mocked(repository.listCatalogueRowsOfSource).mockImplementation(async (_db, source) =>
      source === 'mcp_registry'
        ? ([storedRowOf(server('com.notion2/mcp', 'https://mcp.notion2.com/mcp'))] as never)
        : [],
    );
    const docker = (name: string, url: string) =>
      listedFromDocker({ name, type: 'remote', remote: { transport_type: 'sse', url } }, 'v1');
    const outcomes = await syncCatalogueSources({} as never, {
      now,
      curated,
      overrides: {},
      isDue: async (source) => source === 'docker',
      sources: [
        { source: 'mcp_registry', label: 'registry', read: vi.fn() },
        {
          source: 'docker',
          label: 'docker',
          read: async () => ({
            malformed: 0,
            servers: [
              docker('notion2', 'https://mcp.notion2.com/mcp'),
              docker('aisfleet', 'https://mcp.aisfleet.com/sse'),
            ],
          }),
        },
      ],
    });
    expect(outcomes.mcp_registry).toBeUndefined();
    expect(outcomes.docker).toMatchObject({
      report: { candidates: 1, created: 1, refused: { earlier_source: 1 } },
    });
    const inserted = vi.mocked(repository.insertCatalogueRows).mock.calls.at(-1)?.[1];
    expect(inserted?.map((row) => [row.id, row.source, row.trust])).toEqual([
      ['docker:aisfleet', 'docker', 'verified'],
    ]);
  });

  it('waits while the registry asked to', async () => {
    const until = new Date('2026-11-13T14:00:00Z');
    vi.mocked(repository.getCatalogueSyncState).mockResolvedValueOnce({
      retryAfter: until,
    } as never);
    const read = vi.fn();
    expect(await syncConnectorCatalogue({} as never, { read, curated, now })).toEqual({
      status: 'deferred',
      until,
    });
    expect(read).not.toHaveBeenCalled();
  });
});
