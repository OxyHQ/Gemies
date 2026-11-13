import { describe, expect, it } from 'vitest';
import type { RegistryServer } from '../official-registry.js';
import {
  candidateFromRegistry,
  categoryOf,
  endpointKey,
  isSyncedEntryId,
  preferredListing,
  slugOf,
  trustOf,
} from '../policy.js';

function listed(
  server: Partial<RegistryServer['server']> & { name: string },
  status = 'active',
): RegistryServer {
  return {
    server: { version: '1.0.0', ...server },
    _meta: {
      'io.modelcontextprotocol.registry/official': { status, updatedAt: '2026-10-01T00:00:00Z' },
    },
  };
}

describe('what the store takes from the registry', () => {
  it('takes a remote server, preferring streamable HTTP, with its sanitised listing', () => {
    const read = candidateFromRegistry(
      listed({
        name: 'com.notion/mcp',
        title: `Notion${String.fromCodePoint(0x200b)}`,
        description: 'Official <IMPORTANT>do this</IMPORTANT> server',
        websiteUrl: 'https://www.notion.com',
        remotes: [
          { type: 'sse', url: 'https://mcp.notion.com/sse' },
          { type: 'streamable-http', url: 'https://mcp.notion.com/mcp' },
        ],
      }),
    );
    expect(read).toMatchObject({
      ok: true,
      candidate: {
        id: 'mcp_registry:com.notion/mcp',
        name: 'Notion',
        description: 'Official do this server',
        url: 'https://mcp.notion.com/mcp',
        transport: 'streamable-http',
        trust: 'official',
        slug: 'notion',
        websiteUrl: 'https://www.notion.com/',
      },
    });
  });

  it('never takes a package, a plain-http or templated URL, a required header or an inactive one', () => {
    const refusal = (server: Parameters<typeof listed>[0], status?: string) => {
      const read = candidateFromRegistry(listed(server, status));
      return read.ok ? null : read.reason;
    };
    expect(refusal({ name: 'io.github.a/stdio' })).toBe('no_remote');
    expect(refusal({ name: 'a.b/x', remotes: [{ type: 'stdio', url: 'npx x' }] })).toBe(
      'no_remote',
    );
    expect(refusal({ name: 'a.b/x', remotes: [{ type: 'sse', url: 'http://a.b/sse' }] })).toBe(
      'not_https',
    );
    expect(
      refusal({
        name: 'a.b/x',
        remotes: [{ type: 'streamable-http', url: 'https://{tenant}.b.a/mcp' }],
      }),
    ).toBe('templated_url');
    expect(
      refusal({
        name: 'a.b/x',
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://mcp.b.a/mcp',
            headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
          },
        ],
      }),
    ).toBe('requires_headers');
    expect(
      refusal(
        { name: 'a.b/x', remotes: [{ type: 'streamable-http', url: 'https://mcp.b.a/mcp' }] },
        'deprecated',
      ),
    ).toBe('not_active');
  });

  it('keeps a remote whose header is optional', () => {
    const read = candidateFromRegistry(
      listed({
        name: 'a.b/x',
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://mcp.b.a/mcp',
            headers: [{ name: 'Authorization', isRequired: false }],
          },
        ],
      }),
    );
    expect(read.ok).toBe(true);
  });

  it('leaves out what the operator hid, by name or by host', () => {
    const server = listed({
      name: 'com.spam/mcp',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.spam.com/mcp' }],
    });
    expect(candidateFromRegistry(server, { 'com.spam/mcp': { hide: 'spam' } })).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(candidateFromRegistry(server, { 'host:mcp.spam.com': { hide: 'spam' } })).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(candidateFromRegistry(server, { 'host:spam.com': { hide: 'spam' } })).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(candidateFromRegistry(server, { 'publisher:com.spam': { hide: 'spam' } })).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it("never takes Smithery's shut-down proxies", () => {
    const proxied = candidateFromRegistry(
      listed({
        name: 'ai.smithery/notion',
        remotes: [{ type: 'streamable-http', url: 'https://notion.run.tools' }],
      }),
    );
    expect(proxied).toEqual({ ok: false, reason: 'denied' });
  });
});

describe('badges, slugs, categories', () => {
  it('is official only on the domain its publisher proved', () => {
    expect(trustOf('com.notion/mcp', 'https://mcp.notion.com/mcp')).toBe('official');
    expect(trustOf('com.notion/mcp', 'https://notion.com/mcp')).toBe('official');
    expect(trustOf('com.notion/mcp', 'https://notion.vercel.app/mcp')).toBe('verified');
    expect(trustOf('uk.co.shop/mcp', 'https://other.co.uk/mcp')).toBe('verified');
    expect(trustOf('io.github.ana/notes', 'https://ana.github.io/mcp')).toBe('community');
  });

  it('makes a short slug that names tools, never a generic word', () => {
    expect(slugOf('com.notion/mcp', 'Notion')).toBe('notion');
    expect(slugOf('com.acme/mcp', 'MCP Server')).toBe('acme');
    expect(slugOf('io.github.ana/weather-mcp', '')).toBe('weather');
    expect(
      slugOf('com.example/a-very-long-server-name-indeed-and-more', '').length,
    ).toBeLessThanOrEqual(24);
  });

  it('reads a category from the words, and `other` when none fits', () => {
    expect(categoryOf('Stripe', 'Payments and invoices')).toBe('finance');
    expect(categoryOf('Mailer', 'Send email to your contacts')).toBe('communication');
    expect(categoryOf('Zork', 'A text adventure')).toBe('other');
  });

  it('knows a synced id from a curated one', () => {
    expect(isSyncedEntryId('mcp_registry:com.notion/mcp')).toBe(true);
    expect(isSyncedEntryId('notion')).toBe(false);
  });
});

describe('one listing per endpoint', () => {
  it('reads the same address however it is spelt', () => {
    expect(endpointKey('https://MCP.Example.com/mcp/')).toBe(
      endpointKey('https://mcp.example.com/mcp'),
    );
  });

  it('keeps the best-proven publisher, then the newest', () => {
    const base = candidateFromRegistry(
      listed({
        name: 'io.github.copy/x',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.x.com/mcp' }],
      }),
    );
    const official = candidateFromRegistry(
      listed({
        name: 'com.x/mcp',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.x.com/mcp' }],
      }),
    );
    if (!base.ok || !official.ok) throw new Error('expected candidates');
    expect(preferredListing(base.candidate, official.candidate).upstreamName).toBe('com.x/mcp');
    const newer = {
      ...base.candidate,
      upstreamName: 'io.github.newer/x',
      upstreamUpdatedAt: new Date('2026-11-01'),
    };
    expect(preferredListing(base.candidate, newer).upstreamName).toBe('io.github.newer/x');
  });
});
