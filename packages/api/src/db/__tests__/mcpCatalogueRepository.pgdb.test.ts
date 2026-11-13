import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { mcpCatalogueEntries } from '../schema/integrations';
import {
  getCatalogueSyncState,
  listCatalogueRowsDueForCheck,
  listOfferedCatalogueRows,
  recordCatalogueHealth,
} from '../integrations/mcpCatalogueRepository';
import { syncConnectorCatalogue } from '../../lib/connector-catalogue/sync';

/**
 * The synced half of the connectors store against a REAL server: a sync writes, updates and removes
 * rows, the store offers only healthy ones, and the health round finds what is due.
 *
 * Every server here is named `pgtest.*`, so counts stay scoped to this file's rows.
 */

let db: ApiDatabase;

const now = new Date('2026-11-13T12:00:00Z');

function listed(name: string, url: string) {
  return {
    server: { name, version: '1.0.0', remotes: [{ type: 'streamable-http', url }] },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
  };
}

const pass = (servers: ReturnType<typeof listed>[]) => async () => ({
  servers: servers as never,
  malformed: 0,
});

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await db.delete(mcpCatalogueEntries).where(like(mcpCatalogueEntries.upstreamName, 'pgtest.%'));
  await closePostgres();
});

describe('a sync against the database', () => {
  it('inserts, keeps, removes and brings back servers, and records its report', async () => {
    const first = await syncConnectorCatalogue(db, {
      read: pass([
        listed('pgtest.weather/mcp', 'https://mcp.weather.pgtest/mcp'),
        listed('pgtest.maps/mcp', 'https://mcp.maps.pgtest/mcp'),
      ]),
      curated: [],
      overrides: {},
      now,
    });
    expect(first).toMatchObject({ status: 'synced', report: { created: 2 } });

    const again = await syncConnectorCatalogue(db, {
      read: pass([listed('pgtest.weather/mcp', 'https://mcp.weather.pgtest/mcp')]),
      curated: [],
      overrides: {},
      now,
    });
    expect(again).toMatchObject({ report: { unchanged: 1, removed: 1 } });
    const [maps] = await db
      .select()
      .from(mcpCatalogueEntries)
      .where(eq(mcpCatalogueEntries.id, 'mcp_registry:pgtest.maps/mcp'));
    expect(maps?.removedAt).toEqual(now);

    const back = await syncConnectorCatalogue(db, {
      read: pass([
        listed('pgtest.weather/mcp', 'https://mcp.weather.pgtest/mcp'),
        listed('pgtest.maps/mcp', 'https://mcp.maps.pgtest/mcp'),
      ]),
      curated: [],
      overrides: {},
      now,
    });
    expect(back).toMatchObject({ report: { updated: 1, unchanged: 1, removed: 0 } });
    expect((await getCatalogueSyncState(db, 'mcp_registry'))?.lastReport).toMatchObject({
      updated: 1,
    });
  });

  it('offers a server only once it is healthy and signed in to in a way Gemies supports', async () => {
    const offered = async () =>
      (await listOfferedCatalogueRows(db))
        .map((row) => row.id)
        .filter((id) => id.includes('pgtest.'))
        .sort();
    expect(await offered()).toEqual([]);

    await recordCatalogueHealth(
      db,
      'mcp_registry:pgtest.weather/mcp',
      {
        health: 'healthy',
        auth: 'none',
        healthMessage: null,
        consecutiveFailures: 0,
        toolCount: 2,
      },
      now,
    );
    await recordCatalogueHealth(
      db,
      'mcp_registry:pgtest.maps/mcp',
      {
        health: 'healthy',
        auth: 'needs_provider_app',
        healthMessage: 'no registration',
        consecutiveFailures: 0,
      },
      now,
    );
    expect(await offered()).toEqual(['mcp_registry:pgtest.weather/mcp']);
  });

  it('finds what is due for a check: never checked first, then what is stale', async () => {
    const later = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
    const due = (at: Date) =>
      listCatalogueRowsDueForCheck(db, at, 1000).then((rows) =>
        rows.map((row) => row.id).filter((id) => id.includes('pgtest.')),
      );
    // Both were just checked: nothing is due now; four days on, the healthy one is.
    expect(await due(now)).toEqual([]);
    expect(await due(later)).toEqual([
      'mcp_registry:pgtest.maps/mcp',
      'mcp_registry:pgtest.weather/mcp',
    ]);
  });

  it('holds only https endpoints and the known vocabularies', async () => {
    await expect(
      db.execute(sql`
        insert into mcp_catalogue_entries
          (id, source, upstream_name, upstream_version, slug, name, description, category, trust,
           url, transport, first_seen_at)
        values ('mcp_registry:pgtest.plain/mcp', 'mcp_registry', 'pgtest.plain/mcp', '1', 'plain',
          'Plain', '', 'other', 'community', 'http://plain.pgtest/mcp', 'streamable-http', now())`),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('mcp_catalogue_entries_https_check');
      return true;
    });
  });
});
