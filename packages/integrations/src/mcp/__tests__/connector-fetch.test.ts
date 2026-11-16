/**
 * `connectorFetch` hands the MCP SDK what a WHATWG `fetch` would: it asks for the codings it
 * reads and decodes the body, so a server that compresses its answer (asked or not) is read as
 * the JSON it sent, not as its compressed bytes.
 */

import { Readable } from 'node:stream';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorFetch } from '../connector-fetch';

const upstream = vi.hoisted(() => ({
  body: Buffer.alloc(0),
  headers: {} as Record<string, string>,
  sent: {} as Record<string, string>,
}));

// `vi.mock` is hoisted above the imports.
vi.mock('@oxy.so/core/server', () => ({
  SsrfRejection: class SsrfRejection extends Error {},
  safeFetch: vi.fn(async (_url: string, options: { headers: Record<string, string> }) => {
    upstream.sent = options.headers;
    return { response: Readable.from([upstream.body]), status: 200, headers: upstream.headers };
  }),
}));

const answer = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } });

beforeEach(() => {
  upstream.sent = {};
});

describe('connectorFetch', () => {
  it('asks for the codings it decodes, unless the caller chose', async () => {
    upstream.body = Buffer.from(answer);
    upstream.headers = { 'content-type': 'application/json' };
    await connectorFetch('https://mcp.test/mcp', { method: 'POST', body: '{}' });
    expect(upstream.sent['accept-encoding']).toBe('gzip, deflate, br');
    await connectorFetch('https://mcp.test/mcp', { headers: { 'Accept-Encoding': 'identity' } });
    expect(upstream.sent['accept-encoding']).toBe('identity');
  });

  it.each([
    ['gzip', gzipSync(answer)],
    ['br', brotliCompressSync(answer)],
  ])('decodes a %s body', async (coding, body) => {
    upstream.body = body;
    upstream.headers = {
      'content-type': 'application/json',
      'content-encoding': coding,
      'content-length': String(body.length),
    };
    const response = await connectorFetch('https://mcp.test/mcp', { method: 'POST', body: '{}' });
    expect(await response.json()).toEqual(JSON.parse(answer));
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('leaves a coding it does not know as it came', async () => {
    upstream.body = Buffer.from('opaque');
    upstream.headers = { 'content-encoding': 'zstd' };
    const response = await connectorFetch('https://mcp.test/mcp');
    expect(await response.text()).toBe('opaque');
    expect(response.headers.get('content-encoding')).toBe('zstd');
  });
});
