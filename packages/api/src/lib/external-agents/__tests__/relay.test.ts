import http from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tokens: new Map<string, string>(),
  links: new Map<
    string,
    { agentId: string; ownerOxyUserId: string; credentialHash: string | null }
  >(),
}));

vi.mock('../../socket-session-auth.js', () => ({
  authenticateSocketToken: async (token: string | undefined) =>
    (token && state.tokens.get(token)) || null,
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/externalAgentRepository.js', () => ({
  findExternalLink: async (_db: unknown, agentId: string) => state.links.get(agentId),
  markExternalLinkConnected: async () => undefined,
}));

import { hashExternalAgentCredential } from '../credential.js';
import {
  disconnectExternalAgent,
  externalAgentRelayRoute,
  isExternalAgentReachable,
  runExternalTurn,
  shutdownExternalAgentRelay,
} from '../relay.js';
import { routeWebSocketUpgrades } from '../../websocket-upgrades.js';

const CREDENTIAL = 'gxa_agent-1-credential';
const linkOf = (agentId: string, credential: string | null) => ({
  agentId,
  ownerOxyUserId: 'user-nate',
  credentialHash: credential === null ? null : hashExternalAgentCredential(credential),
});
let server: http.Server;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  state.tokens.clear();
  state.links.clear();
  state.tokens.set('tok-nate', 'user-nate');
  state.tokens.set('tok-eve', 'user-eve');
  state.links.set('agent-1', linkOf('agent-1', CREDENTIAL));
  server = http.createServer();
  routeWebSocketUpgrades(server, {
    socketIoPath: '/socket.io/',
    routes: [externalAgentRelayRoute(undefined, { authTimeoutMs: 300 })],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  shutdownExternalAgentRelay();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function open(): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/external-agent`);
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
    sockets.push(ws);
  });
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function authenticate(auth: Record<string, unknown>) {
  const client = await open();
  client.ws.send(JSON.stringify({ type: 'auth', ...auth }));
  return client;
}

const connect = (credential = CREDENTIAL, agentId = 'agent-1') =>
  authenticate({ credential, agentId });

async function firstFrame(auth: Record<string, unknown>) {
  const client = await authenticate(auth);
  await waitFor(() => client.frames.length > 0);
  return client.frames[0];
}

describe('external agent relay', () => {
  it('opens a live link with its own credential and reports presence', async () => {
    const { frames } = await connect();
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual({ type: 'auth-ok', agentId: 'agent-1' });
    expect(await isExternalAgentReachable('agent-1')).toBe(true);
  });

  it('refuses another credential, and closes the socket', async () => {
    const { frames, ws } = await connect('gxa_someone-else');
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual({ type: 'auth-error', reason: 'invalid_credential' });
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    expect(await isExternalAgentReachable('agent-1')).toBe(false);
  });

  it('never opens a link that has a credential with the owner’s Oxy session', async () => {
    expect(await firstFrame({ token: 'tok-nate', agentId: 'agent-1' })).toEqual({
      type: 'auth-error',
      reason: 'invalid_credential',
    });
  });

  it('refuses an agent with no live link', async () => {
    expect(await firstFrame({ credential: CREDENTIAL, agentId: 'agent-404' })).toEqual({
      type: 'auth-error',
      reason: 'unknown_agent',
    });
  });

  it('opens a link paired before credentials with its owner’s session, and nobody else’s', async () => {
    state.links.set('legacy', linkOf('legacy', null));
    expect(await firstFrame({ token: 'tok-eve', agentId: 'legacy' })).toEqual({
      type: 'auth-error',
      reason: 'invalid_credential',
    });
    expect(await firstFrame({ token: 'nope', agentId: 'legacy' })).toEqual({
      type: 'auth-error',
      reason: 'invalid_credential',
    });
    expect(await firstFrame({ credential: CREDENTIAL, agentId: 'legacy' })).toEqual({
      type: 'auth-error',
      reason: 'invalid_credential',
    });
    expect(await firstFrame({ token: 'tok-nate', agentId: 'legacy' })).toEqual({
      type: 'auth-ok',
      agentId: 'legacy',
    });
  });

  it('closes a socket that never authenticates', async () => {
    const { ws } = await open();
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
  });

  it('streams a turn: deltas are surfaced and end resolves with the full text', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const deltas: string[] = [];
    const turn = runExternalTurn({
      agentId: 'agent-1',
      task: 'say hi',
      history: [{ role: 'user', content: 'earlier' }],
      onDelta: (t) => deltas.push(t),
    });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const frame = frames.find((f) => f.type === 'turn') as { turnId: string; task: string };
    expect(frame.task).toBe('say hi');
    ws.send(JSON.stringify({ type: 'delta', turnId: frame.turnId, text: 'Hel' }));
    ws.send(JSON.stringify({ type: 'delta', turnId: frame.turnId, text: 'lo' }));
    ws.send(JSON.stringify({ type: 'end', turnId: frame.turnId }));
    await expect(turn).resolves.toEqual({ response: 'Hello' });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('fails a turn when the daemon reports an error', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [] });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const { turnId } = frames.find((f) => f.type === 'turn') as { turnId: string };
    ws.send(JSON.stringify({ type: 'error', turnId, message: 'codex exited 1' }));
    await expect(turn).rejects.toThrow('codex exited 1');
  });

  it('answers offline without hanging when nobody is connected', async () => {
    await expect(runExternalTurn({ agentId: 'agent-1', task: 'x', history: [] })).rejects.toThrow(
      /not connected/,
    );
  });

  it('fails an in-flight turn when the daemon drops', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [] });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    ws.terminate();
    await expect(turn).rejects.toThrow(/disconnected/);
    expect(await isExternalAgentReachable('agent-1')).toBe(false);
  });

  it('times a turn out and tells the daemon to cancel', async () => {
    const { frames } = await connect();
    await waitFor(() => frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [], timeoutMs: 50 });
    await expect(turn).rejects.toThrow(/did not answer/);
    await waitFor(() => frames.some((f) => f.type === 'cancel'));
  });

  it('cuts the daemon off on revocation', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    disconnectExternalAgent('agent-1', { reason: 'revoked' });
    await waitFor(() => frames.some((f) => f.type === 'revoked'));
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    expect(await isExternalAgentReachable('agent-1')).toBe(false);
  });

  it('cuts off the daemon of a replaced credential, untold, and keeps one holding the new credential', async () => {
    const old = await connect();
    await waitFor(() => old.frames.length > 0);
    disconnectExternalAgent('agent-1', { reason: 'credential-replaced', credentialHash: 'new' });
    await waitFor(() => old.ws.readyState === WebSocket.CLOSED);
    expect(old.frames.some((f) => f.type === 'revoked')).toBe(false);

    state.links.set('agent-1', linkOf('agent-1', 'gxa_new'));
    const fresh = await connect('gxa_new');
    await waitFor(() => fresh.frames.length > 0);
    disconnectExternalAgent('agent-1', {
      reason: 'credential-replaced',
      credentialHash: hashExternalAgentCredential('gxa_new'),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fresh.ws.readyState).toBe(WebSocket.OPEN);
    expect(await isExternalAgentReachable('agent-1')).toBe(true);
  });

  it('ignores answers for a turn that belongs to another agent', async () => {
    state.links.set('agent-2', linkOf('agent-2', 'gxa_two'));
    const one = await connect(CREDENTIAL, 'agent-1');
    const two = await connect('gxa_two', 'agent-2');
    await waitFor(() => one.frames.length > 0 && two.frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [], timeoutMs: 200 });
    await waitFor(() => one.frames.some((f) => f.type === 'turn'));
    const { turnId } = one.frames.find((f) => f.type === 'turn') as { turnId: string };
    two.ws.send(JSON.stringify({ type: 'end', turnId, text: 'forged' }));
    await expect(turn).rejects.toThrow(/did not answer/);
  });
});
