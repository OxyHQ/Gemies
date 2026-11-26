import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redeemCode } from '../redeem.js';

/**
 * Redeeming a pairing code (Gemies ADR 0038): one unauthenticated POST, the code being the whole
 * authorisation, answered with the agent's own credential.
 */

let server: Server;
let apiBaseUrl: string;
let reply: { status: number; body: unknown };
let seen: { headers: IncomingHttpHeaders; url?: string; body: unknown }[];

beforeEach(async () => {
  seen = [];
  reply = {
    status: 201,
    body: { agentId: 'agent-1', name: 'Codex · laptop', credential: 'gxa_x' },
  };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      seen.push({ headers: req.headers, url: req.url, body: JSON.parse(raw) });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const redeem = () =>
  redeemCode({ apiBaseUrl, code: 'ABCD-EFGH-JKMN-PQRS', cli: 'codex', hostName: 'laptop' });

describe('redeemCode', () => {
  it('sends the code with no credential of any kind, and keeps the agent’s credential', async () => {
    expect(await redeem()).toEqual({
      agentId: 'agent-1',
      name: 'Codex · laptop',
      cli: 'codex',
      apiBaseUrl,
      credential: 'gxa_x',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/agents/external/redeem');
    expect(seen[0].body).toEqual({ code: 'ABCD-EFGH-JKMN-PQRS', cli: 'codex', hostName: 'laptop' });
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers.cookie).toBeUndefined();
  });

  it('says what to do for a refused code, a rate limit and a server error', async () => {
    reply = { status: 400, body: { error: 'invalid_or_expired_code' } };
    expect(await redeem()).toMatch(/invalid, expired or already used.*Create a code in Gemies/);
    reply = { status: 429, body: { error: 'rate_limited' } };
    expect(await redeem()).toMatch(/Too many attempts/);
    reply = { status: 500, body: {} };
    expect(await redeem()).toMatch(/HTTP 500/);
  });

  it('reports an unreachable server instead of throwing', async () => {
    expect(
      await redeemCode({
        apiBaseUrl: 'http://127.0.0.1:1',
        code: 'ABCD-EFGH-JKMN-PQRS',
        cli: 'codex',
        hostName: 'laptop',
      }),
    ).toMatch(/Could not reach Gemies/);
  });
});
