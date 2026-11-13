import { describe, expect, it } from 'vitest';
import { type CatalogueEntry, queryCatalogue } from '../catalogue.js';

function entry(overrides: Partial<CatalogueEntry>): CatalogueEntry {
  return {
    id: 'x',
    slug: 'x',
    name: 'X',
    description: '',
    category: 'other',
    url: 'https://x.test/mcp',
    transport: 'streamable-http',
    signIn: 'oauth',
    trust: 'community',
    source: 'mcp_registry',
    featured: false,
    docsUrl: null,
    toolCount: null,
    updatedAt: null,
    ...overrides,
  };
}

const entries = [
  entry({
    id: 'zed',
    name: 'Zed',
    trust: 'community',
    category: 'data',
    updatedAt: new Date('2026-11-01'),
  }),
  entry({
    id: 'notion',
    name: 'Notion',
    source: 'curated',
    trust: 'official',
    featured: true,
    category: 'productivity',
  }),
  entry({
    id: 'acme',
    name: 'Acme',
    trust: 'verified',
    signIn: 'none',
    category: 'data',
    updatedAt: new Date('2026-10-01'),
  }),
  entry({
    id: 'beta',
    name: 'Beta',
    trust: 'official',
    description: 'Weather data',
    category: 'data',
  }),
];

describe('a page of the store', () => {
  it('puts the featured, the curated and the best-proven first', () => {
    expect(queryCatalogue(entries, {}).entries.map((e) => e.id)).toEqual([
      'notion',
      'beta',
      'acme',
      'zed',
    ]);
  });

  it('sorts by name or by what changed last', () => {
    expect(queryCatalogue(entries, { sort: 'name' }).entries.map((e) => e.id)).toEqual([
      'acme',
      'beta',
      'notion',
      'zed',
    ]);
    expect(queryCatalogue(entries, { sort: 'recent' }).entries[0]?.id).toBe('zed');
  });

  it('searches every word, filters, and counts the categories under the same filters', () => {
    const page = queryCatalogue(entries, { q: 'weather data', trust: ['official'] });
    expect(page.entries.map((e) => e.id)).toEqual(['beta']);
    expect(page.categories).toEqual([{ id: 'data', count: 1 }]);
    expect(queryCatalogue(entries, { noSignIn: true }).entries.map((e) => e.id)).toEqual(['acme']);
    expect(queryCatalogue(entries, { category: 'data' }).total).toBe(3);
  });

  it('pages, and says where the next page starts', () => {
    const first = queryCatalogue(entries, { limit: 3 });
    expect(first).toMatchObject({ total: 4, nextOffset: 3 });
    expect(queryCatalogue(entries, { limit: 3, offset: 3 })).toMatchObject({ nextOffset: null });
  });
});
