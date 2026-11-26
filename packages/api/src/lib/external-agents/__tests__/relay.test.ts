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
  answerExternalApproval,
  isExternalAgentReachable,
  listExternalAgentSessions as listSessionsOf,
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
    expect(frames[0]).toEqual({ type: 'auth-ok', agentId: 'agent-1', features: ['approvals'] });
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
      features: ['approvals'],
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

  it('carries the folder of a session in the turn frame, and none for a turn without one', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const withFolder = runExternalTurn({
      agentId: 'agent-1',
      task: 'a',
      history: [],
      threadKey: 'c-1',
      cwd: '/home/ana/app',
    });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const first = frames.find((f) => f.type === 'turn') as { turnId: string; cwd?: string };
    expect(first.cwd).toBe('/home/ana/app');
    ws.send(JSON.stringify({ type: 'end', turnId: first.turnId, text: 'ok' }));
    await withFolder;

    frames.length = 0;
    const plain = runExternalTurn({ agentId: 'agent-1', task: 'b', history: [] });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const second = frames.find((f) => f.type === 'turn') as { turnId: string };
    expect(second).not.toHaveProperty('cwd');
    ws.send(JSON.stringify({ type: 'end', turnId: second.turnId, text: 'ok' }));
    await plain;
  });

  it('asks the daemon for its CLI’s sessions and keeps only well-formed entries', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const listing = listSessionsOf('agent-1');
    await waitFor(() => frames.some((f) => f.type === 'list-sessions'));
    const ask = frames.find((f) => f.type === 'list-sessions') as { requestId: string };
    ws.send(
      JSON.stringify({
        type: 'sessions',
        requestId: ask.requestId,
        sessions: [
          { id: 'good-session-1', cwd: '/w', title: 'fix it', updatedAt: 5 },
          { id: '--bad; id', cwd: '/w', title: 'x', updatedAt: 1 },
          { id: 'no-folder-0001', cwd: '', title: 'x', updatedAt: 1 },
          { id: 'nul-folder-001', cwd: '/a\0b', title: 'x', updatedAt: 1 },
          'junk',
          { id: 'no-title-00001', cwd: '/w', updatedAt: 'soon' },
        ],
        roots: ['/home/ana/code', 'relative/path', '', 7, '/a\0b', '~/work', '/home/ana/code'],
      }),
    );
    await expect(listing).resolves.toEqual({
      sessions: [
        { id: 'good-session-1', cwd: '/w', title: 'fix it', updatedAt: 5 },
        { id: 'no-title-00001', cwd: '/w', title: 'no-title', updatedAt: 0 },
      ],
      roots: ['/home/ana/code', '~/work'],
    });
  });

  it('ignores a listing for a request that is not its own, and fails when nobody is connected', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    ws.send(JSON.stringify({ type: 'sessions', requestId: 'never-asked', sessions: [] }));
    await expect(listSessionsOf('agent-9')).rejects.toThrow(/not connected/);
  });

  it('fails a pending listing when the daemon drops', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const listing = listSessionsOf('agent-1');
    await waitFor(() => frames.some((f) => f.type === 'list-sessions'));
    ws.close();
    await expect(listing).rejects.toThrow(/disconnected/);
  });

  it('surfaces the tools the daemon reports, validated, tagged with their own turn only', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const seen: unknown[] = [];
    const turn = runExternalTurn({
      agentId: 'agent-1',
      task: 'a',
      history: [],
      onActivity: (a) => seen.push(a),
    });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const { turnId } = frames.find((f) => f.type === 'turn') as { turnId: string };
    const send = (activity: unknown, id = turnId) =>
      ws.send(JSON.stringify({ type: 'activity', turnId: id, activity }));
    send({ id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'running' });
    send({ id: 'a', tool: 'Read', summary: 'x'.repeat(500), status: 'done' });
    send({ id: 'b', tool: 'Bash', status: 'exploded' });
    send({ id: '', tool: 'Bash', status: 'running' });
    send({ tool: 'Bash', status: 'running' });
    send('junk');
    send({ id: 'c', tool: 'Bash', status: 'running' }, 'another-turn');
    ws.send(JSON.stringify({ type: 'end', turnId, text: 'ok' }));
    await turn;
    expect(seen).toEqual([
      { id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'running' },
      { id: 'a', tool: 'Read', summary: 'x'.repeat(200), status: 'done' },
    ]);
  });

  it('surfaces a permission question and its closing, validated, and carries the answer to the daemon', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const events: unknown[] = [];
    const turn = runExternalTurn({
      agentId: 'agent-1',
      task: 'a',
      history: [],
      onApproval: (e) => events.push(e),
    });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const { turnId } = frames.find((f) => f.type === 'turn') as { turnId: string };
    const requestId = '11111111-2222-4333-8444-555555555555';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const send = (frame: object) => ws.send(JSON.stringify(frame));
    send({
      type: 'approval-request',
      turnId,
      requestId,
      tool: 'Bash',
      summary: 'x'.repeat(500),
      expiresAt,
    });
    send({ type: 'approval-request', turnId, requestId: 'not-a-uuid', tool: 'Bash', expiresAt });
    send({ type: 'approval-request', turnId, requestId, tool: '', expiresAt });
    send({ type: 'approval-request', turnId, requestId, tool: 'Bash', expiresAt: 'tomorrow-ish' });
    send({ type: 'approval-request', turnId: 'another-turn', requestId, tool: 'Bash', expiresAt });
    send({ type: 'approval-resolved', turnId, requestId, decision: 'allow' });
    send({ type: 'approval-resolved', turnId, requestId, decision: 'whatever' });
    await waitFor(() => events.length === 2);

    answerExternalApproval('agent-1', requestId, 'allow');
    await waitFor(() => frames.some((f) => f.type === 'approval'));
    expect(frames.find((f) => f.type === 'approval')).toEqual({
      type: 'approval',
      requestId,
      decision: 'allow',
    });

    send({ type: 'end', turnId, text: 'ok' });
    await turn;
    expect(events).toEqual([
      { kind: 'request', requestId, tool: 'Bash', summary: 'x'.repeat(200), expiresAt },
      { kind: 'resolved', requestId, decision: 'allow' },
    ]);
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
