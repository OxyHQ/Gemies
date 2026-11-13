/**
 * The store's health check against fake servers: one that needs no sign-in (MCP over streamable
 * HTTP, answered as plain JSON), one that wants OAuth with or without Dynamic Client Registration,
 * and one that never answers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeConnector } from '../probe';

// `vi.mock` is hoisted above the imports; the routes it reads are filled per test.
const routes = vi.hoisted(
  () => new Map<string, (request: Request) => Response | Promise<Response>>(),
);

vi.mock('../connector-fetch', () => ({
  connectorFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const route = routes.get(`${request.method} ${url.origin}${url.pathname}`);
    return route ? route(request) : new Response('not found', { status: 404 });
  },
}));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/** A server that answers JSON-RPC over plain JSON responses, with no sign-in. */
function openServer(url: string, tools: { name: string; description: string }[]) {
  routes.set(`POST ${url}`, async (request) => {
    const message = (await request.json()) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === 'initialize') {
      return json(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'weather',
              version: '1.0.0',
              icons: [{ src: 'https://weather.test/icon.svg', mimeType: 'image/svg+xml' }],
            },
          },
        },
        200,
        { 'mcp-session-id': 'probe-session' },
      );
    }
    if (message.method === 'tools/list') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: tools.map((tool) => ({ ...tool, inputSchema: { type: 'object' } })),
        },
      });
    }
    return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } });
  });
  routes.set(`GET ${url}`, () => new Response(null, { status: 405 }));
  routes.set(`DELETE ${url}`, () => new Response(null, { status: 200 }));
}

function oauthServer(registration: boolean) {
  routes.set('POST https://mcp.private.test/mcp', () =>
    json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate':
        'Bearer resource_metadata="https://mcp.private.test/.well-known/oauth-protected-resource/mcp"',
    }),
  );
  routes.set('GET https://mcp.private.test/.well-known/oauth-protected-resource/mcp', () =>
    json({
      resource: 'https://mcp.private.test/mcp',
      authorization_servers: ['https://auth.private.test'],
    }),
  );
  routes.set('GET https://auth.private.test/.well-known/oauth-authorization-server', () =>
    json({
      issuer: 'https://auth.private.test',
      authorization_endpoint: 'https://auth.private.test/authorize',
      token_endpoint: 'https://auth.private.test/token',
      response_types_supported: ['code'],
      ...(registration ? { registration_endpoint: 'https://auth.private.test/register' } : {}),
    }),
  );
}

beforeEach(() => routes.clear());

describe('the store health check', () => {
  it('lists the tools and the icon of a server that needs no sign-in', async () => {
    openServer('https://mcp.weather.test/mcp', [{ name: 'forecast', description: 'Forecasts' }]);
    const result = await probeConnector('https://mcp.weather.test/mcp', 'streamable-http');
    expect(result).toEqual({
      outcome: 'open',
      tools: [{ name: 'forecast', description: 'Forecasts' }],
      server: {
        name: 'weather',
        icons: [{ src: 'https://weather.test/icon.svg', mimeType: 'image/svg+xml' }],
      },
    });
  });

  it('says whether a server that wants OAuth takes Dynamic Client Registration', async () => {
    oauthServer(true);
    expect(await probeConnector('https://mcp.private.test/mcp', 'streamable-http')).toEqual({
      outcome: 'oauth',
      registration: true,
    });
    routes.clear();
    oauthServer(false);
    expect(await probeConnector('https://mcp.private.test/mcp', 'streamable-http')).toEqual({
      outcome: 'oauth',
      registration: false,
    });
  });

  it('fails a server that does not speak MCP, and one that never answers', async () => {
    routes.set(
      'POST https://www.blog.test/mcp',
      () => new Response('<html></html>', { status: 200 }),
    );
    expect(await probeConnector('https://www.blog.test/mcp', 'streamable-http')).toMatchObject({
      outcome: 'failed',
    });

    routes.set(
      'POST https://slow.test/mcp',
      (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason)),
        ),
    );
    expect(await probeConnector('https://slow.test/mcp', 'streamable-http', 200)).toEqual({
      outcome: 'failed',
      reason: 'no answer within 0.2 s',
    });
  });
});
