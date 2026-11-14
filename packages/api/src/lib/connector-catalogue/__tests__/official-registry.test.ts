import { describe, expect, it, vi } from 'vitest';
import { readOfficialRegistry } from '../official-registry.js';
import { CatalogueRateLimitError } from '../policy.js';

function page(servers: unknown[], nextCursor?: string) {
  return new Response(
    JSON.stringify({ servers, metadata: { nextCursor, count: servers.length } }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

const item = (name: string) => ({ server: { name, version: '1.0.0' } });

describe('reading the official MCP Registry', () => {
  it('follows the cursor to the end, latest versions only, skipping what does not parse', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page([item('a.b/one'), { server: { name: 3 } }], 'a.b/one:1.0.0'))
      .mockResolvedValueOnce(page([item('a.b/two')]));
    const pass = await readOfficialRegistry(fetchImpl as unknown as typeof fetch, 0);

    expect(pass.servers.map((listed) => listed.name)).toEqual(['a.b/one', 'a.b/two']);
    expect(pass.malformed).toBe(1);
    const first = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(first.origin + first.pathname).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers',
    );
    expect(first.searchParams.get('version')).toBe('latest');
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get('cursor')).toBe(
      'a.b/one:1.0.0',
    );
  });

  it('stops at a rate limit with when to come back', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    await expect(
      readOfficialRegistry(fetchImpl as unknown as typeof fetch, 0),
    ).rejects.toBeInstanceOf(CatalogueRateLimitError);
  });

  it('asks a failed page again, and never returns half a registry', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page([item('a.b/one')], 'next'))
      .mockImplementation(async () => new Response('oops', { status: 502 }));
    await expect(readOfficialRegistry(fetchImpl as unknown as typeof fetch, 0)).rejects.toThrow(
      /502/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
