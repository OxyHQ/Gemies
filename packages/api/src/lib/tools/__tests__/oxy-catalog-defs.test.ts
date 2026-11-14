import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ serviceCatalogs: vi.fn(), error: vi.fn() }));

vi.mock('../../oxy.js', () => ({ oxy: { agency: { serviceCatalogs: H.serviceCatalogs } } }));
vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: H.error, debug: vi.fn() } },
}));

import { registeredCatalog } from '../../__tests__/fixtures/oxy-catalog.js';
import { DEFS_KEY, defsCache, getCatalogDefs } from '../oxy-catalog-defs.js';

function catalog(appId: string, toolName: string) {
  return {
    schemaVersion: '1',
    appId,
    version: '1.0.0',
    audience: `oxy-${appId}-api`,
    internalBaseUrl: `https://${appId}.example.test`,
    accountResourceType: `${appId}_account`,
    tools: [
      {
        name: toolName,
        version: '1.0.0',
        description: `${toolName} tool`,
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          additionalProperties: false,
        },
        capabilityPackage: 'read',
        requiredCapabilities: [`${appId}.${toolName}`],
        resourceTypes: [`${appId}_account`],
        effect: 'read',
        idempotency: 'none',
        rollback: 'none',
        exposure: ['internal'],
        invocation: { method: 'GET', path: `/${toolName}` },
        limitKeys: [],
      },
    ],
    events: [],
  };
}

/** A registration whose digest no longer matches its content: it does not parse. */
function broken(appId: string, toolName: string) {
  return { ...registeredCatalog(catalog(appId, toolName)), digest: '0'.repeat(64) };
}

/** A fresh registry read, as after the 60 s cache window. */
async function load() {
  defsCache.delete(DEFS_KEY);
  const defs = await getCatalogDefs();
  return Object.fromEntries(
    defs.map((def) => [def.catalog.appId, def.compiledTools.map((t) => t.definition.name)]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loading the Oxy app catalogues', () => {
  it('keeps the last valid catalogue of an app whose registration stops parsing, and logs it', async () => {
    H.serviceCatalogs.mockResolvedValueOnce([
      registeredCatalog(catalog('noted', 'searchNotes')),
      registeredCatalog(catalog('homiio', 'searchListings')),
    ]);
    expect(await load()).toEqual({ noted: ['searchNotes'], homiio: ['searchListings'] });

    // A bad publish of Noted is not Noted leaving the registry.
    H.serviceCatalogs.mockResolvedValueOnce([
      broken('noted', 'searchNotesV2'),
      registeredCatalog(catalog('homiio', 'searchListings')),
    ]);
    expect(await load()).toEqual({ noted: ['searchNotes'], homiio: ['searchListings'] });
    expect(H.error).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'noted', keepingLastValid: true }),
      expect.any(String),
    );

    // Once it parses again, its new catalogue replaces the kept one.
    H.serviceCatalogs.mockResolvedValueOnce([
      registeredCatalog(catalog('noted', 'searchNotesV2')),
      registeredCatalog(catalog('homiio', 'searchListings')),
    ]);
    expect(await load()).toEqual({ noted: ['searchNotesV2'], homiio: ['searchListings'] });
  });

  it('drops an app the registry no longer lists, and does not bring it back later', async () => {
    H.serviceCatalogs.mockResolvedValueOnce([
      registeredCatalog(catalog('noted', 'searchNotes')),
      registeredCatalog(catalog('homiio', 'searchListings')),
    ]);
    await load();

    H.serviceCatalogs.mockResolvedValueOnce([
      registeredCatalog(catalog('homiio', 'searchListings')),
    ]);
    expect(await load()).toEqual({ homiio: ['searchListings'] });

    // Its last valid catalogue went with it: a broken return is not served from it.
    H.serviceCatalogs.mockResolvedValueOnce([
      broken('noted', 'searchNotes'),
      registeredCatalog(catalog('homiio', 'searchListings')),
    ]);
    expect(await load()).toEqual({ homiio: ['searchListings'] });
  });

  it('skips an app whose registration never parsed, without costing the others', async () => {
    H.serviceCatalogs.mockResolvedValueOnce([
      broken('mention', 'searchPosts'),
      registeredCatalog(catalog('homiio', 'searchListings')),
    ]);
    expect(await load()).toEqual({ homiio: ['searchListings'] });
    expect(H.error).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'mention', keepingLastValid: false }),
      expect.any(String),
    );
  });
});
