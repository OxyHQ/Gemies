/**
 * `/agents/external/*` — pairing a person's coding-agent CLI with Gemies (ADR 0030, 0036, 0038). The
 * rules under test: a signed-in person mints a code bound to them; redeeming needs no session, acts
 * for the code's owner, creates ONE private unlisted gemie with no Oxy account plus its link, and
 * returns a credential stored only as a hash; a reconnect code replaces an existing agent's
 * credential instead; an unusable code creates nothing; attempts are rate limited; revoking cuts the
 * daemon off.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashExternalAgentCredential } from '../../../lib/external-agents/credential.js';
import { resetLocalWindows } from '../../../lib/sliding-window-limiter.js';

const state = vi.hoisted(() => ({
  userId: 'owner-1',
  online: new Set<string>(),
  tx: { tx: true },
  createPairing: vi.fn(),
  redeemPairing: vi.fn(),
  findLink: vi.fn(),
  replaceCredential: vi.fn(),
  findAgent: vi.fn(),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  createLink: vi.fn(),
  revoke: vi.fn(),
  disconnect: vi.fn(),
  openSession: vi.fn(),
  folders: vi.fn(),
  listTerminal: vi.fn(),
  answerApproval: vi.fn(),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: state.userId }, accessToken: 'TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({
  getDb: () => ({ transaction: (run: (tx: unknown) => Promise<unknown>) => run(state.tx) }),
}));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  createAgent: state.createAgent,
  deleteAgent: state.deleteAgent,
  findAgentById: state.findAgent,
}));
vi.mock('../../../db/agents/externalAgentRepository.js', () => ({
  createPairing: state.createPairing,
  redeemPairing: state.redeemPairing,
  findExternalLink: state.findLink,
  replaceExternalLinkCredential: state.replaceCredential,
  createExternalLink: state.createLink,
  revokeExternalLink: state.revoke,
  openExternalSession: state.openSession,
  recentExternalFolders: state.folders,
  listExternalLinks: vi.fn(async () => [
    { agentId: 'a1', cli: 'codex', hostName: 'laptop', createdAt: 'x', lastConnectedAt: null },
    { agentId: 'a2', cli: 'claude', hostName: 'desk', createdAt: 'y', lastConnectedAt: null },
  ]),
}));
vi.mock('../../../lib/external-agents/relay.js', () => ({
  isExternalAgentReachable: async (id: string) => state.online.has(id),
  disconnectExternalAgent: state.disconnect,
  listExternalAgentSessions: state.listTerminal,
  answerExternalApproval: state.answerApproval,
  ExternalAgentOfflineError: class ExternalAgentOfflineError extends Error {},
}));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child, rateLimit: child } };
});

const { default: router } = await import('../external-agents.js');

const app = express();
app.use(express.json());
app.use('/agents', router);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalWindows();
  state.userId = 'owner-1';
  state.online.clear();
  state.redeemPairing.mockResolvedValue({ ownerOxyUserId: 'owner-1', agentId: null });
  state.findLink.mockResolvedValue({ agentId: 'agent-1', ownerOxyUserId: 'owner-1' });
  state.replaceCredential.mockResolvedValue(true);
  state.findAgent.mockResolvedValue({
    _id: 'agent-1',
    identity: { source: 'local', name: 'My Claude', color: 'orange' },
  });
  state.createAgent.mockResolvedValue({ _id: 'agent-1' });
  state.revoke.mockResolvedValue(true);
  state.deleteAgent.mockResolvedValue(1);
});

const post = (path: string, body: unknown) =>
  fetch(`${base}/agents/external${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /agents/external/pair', () => {
  it('mints a code for the caller, stores only its hash and returns the text to paste', async () => {
    state.userId = 'pair-user-a';
    const response = await post('/pair', { locale: 'es' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string; prompt: string; expiresAt: string };
    expect(body.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(body.prompt).toContain(`connect ${body.code} --cli`);
    expect(body.prompt).toContain('Quiero conectarte');
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    const stored = state.createPairing.mock.calls[0][1] as Record<string, unknown>;
    expect(stored.ownerOxyUserId).toBe('pair-user-a');
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toHaveProperty('agentId');
    expect(JSON.stringify(stored)).not.toContain(body.code);
  });

  it('mints a reconnect code for an external agent of the caller’s, and 404s anyone else’s', async () => {
    expect((await post('/pair', { agentId: 'agent-1' })).status).toBe(201);
    expect(state.createPairing.mock.calls[0][1]).toMatchObject({
      ownerOxyUserId: 'owner-1',
      agentId: 'agent-1',
    });

    state.findLink.mockResolvedValue({ agentId: 'agent-1', ownerOxyUserId: 'someone-else' });
    expect((await post('/pair', { agentId: 'agent-1' })).status).toBe(404);
    state.findLink.mockResolvedValue(undefined);
    expect((await post('/pair', { agentId: 'agent-9' })).status).toBe(404);
    expect(state.createPairing).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown field', async () => {
    expect((await post('/pair', { owner: 'x' })).status).toBe(400);
  });

  it('rate limits a burst of codes', async () => {
    state.userId = 'pair-user-burst';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post('/pair', {})).status);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('POST /agents/external/redeem', () => {
  const valid = { code: 'ABCD-EFGH-JKMN-PQRS', cli: 'codex', hostName: 'laptop' };
  type Redeemed = { agentId: string; name: string; cli: string; credential: string };

  it('needs no session: the code names the account, and a new private local gemie is made for it', async () => {
    state.userId = 'not-the-redeemer';
    state.redeemPairing.mockResolvedValue({ ownerOxyUserId: 'owner-1', agentId: null });
    const response = await post('/redeem', valid);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Redeemed;
    expect(body).toMatchObject({ agentId: 'agent-1', name: 'Codex · laptop', cli: 'codex' });
    expect(body.credential).toMatch(/^gxa_[A-Za-z0-9_-]{43}$/);

    expect(state.redeemPairing.mock.calls[0][0]).toBe(state.tx);
    const agent = state.createAgent.mock.calls[0][1] as Record<string, unknown>;
    expect(state.createAgent.mock.calls[0][0]).toBe(state.tx);
    expect(agent).toMatchObject({
      identity: { source: 'local', name: 'Codex · laptop', color: 'graphite' },
      isPublished: false,
      access: 'private',
      ownerOxyAccountId: 'owner-1',
    });
    expect(JSON.stringify(agent)).not.toContain('oxyAccountId');
    expect(state.createLink).toHaveBeenCalledWith(state.tx, {
      agentId: 'agent-1',
      ownerOxyUserId: 'owner-1',
      cli: 'codex',
      hostName: 'laptop',
      credentialHash: hashExternalAgentCredential(body.credential),
      machineId: expect.any(String),
    });
    expect(JSON.stringify(state.createLink.mock.calls)).not.toContain(body.credential);
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it('pairs a whole computer with one code: a gemie and a credential per CLI, sharing a machine', async () => {
    state.createAgent
      .mockResolvedValueOnce({ _id: 'agent-c' })
      .mockResolvedValueOnce({ _id: 'agent-x' });
    const response = await post('/redeem', {
      code: valid.code,
      clis: ['claude', 'codex'],
      hostName: 'laptop',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { machineId: string; agents: Redeemed[] };
    expect(body.agents.map((a) => [a.agentId, a.name, a.cli])).toEqual([
      ['agent-c', 'Claude Code · laptop', 'claude'],
      ['agent-x', 'Codex · laptop', 'codex'],
    ]);
    expect(new Set(body.agents.map((a) => a.credential)).size).toBe(2);
    const links = state.createLink.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(links.map((l) => l.machineId)).toEqual([body.machineId, body.machineId]);
    expect(links.map((l) => l.credentialHash)).toEqual(
      body.agents.map((a) => hashExternalAgentCredential(a.credential)),
    );
  });

  it('reconnects an existing agent: a new credential, and the old one’s daemon cut off', async () => {
    state.redeemPairing.mockResolvedValue({ ownerOxyUserId: 'owner-1', agentId: 'agent-1' });
    const response = await post('/redeem', { ...valid, cli: 'claude', hostName: 'desk' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Redeemed;
    expect(body).toMatchObject({ agentId: 'agent-1', name: 'My Claude', cli: 'claude' });
    const credentialHash = hashExternalAgentCredential(body.credential);
    expect(state.replaceCredential).toHaveBeenCalledWith(state.tx, {
      agentId: 'agent-1',
      ownerOxyUserId: 'owner-1',
      cli: 'claude',
      hostName: 'desk',
      credentialHash,
    });
    expect(state.createAgent).not.toHaveBeenCalled();
    expect(state.disconnect).toHaveBeenCalledWith('agent-1', {
      reason: 'credential-replaced',
      credentialHash,
    });
  });

  it('refuses a reconnect code whose agent was revoked since', async () => {
    state.redeemPairing.mockResolvedValue({ ownerOxyUserId: 'owner-1', agentId: 'agent-1' });
    state.replaceCredential.mockResolvedValue(false);
    const response = await post('/redeem', valid);
    expect(response.status).toBe(400);
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it('creates nothing when the code is unknown, expired or used', async () => {
    state.redeemPairing.mockResolvedValue(null);
    const response = await post('/redeem', valid);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_or_expired_code' });
    expect(state.createAgent).not.toHaveBeenCalled();
    expect(state.createLink).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before touching the database', async () => {
    for (const body of [
      { ...valid, cli: 'gemini' },
      { ...valid, code: 'ABCD-EFGH-JKMN' },
      { ...valid, hostName: '' },
      { ...valid, extra: true },
      { ...valid, clis: ['claude'] },
      { code: valid.code, hostName: 'laptop' },
      { code: valid.code, hostName: 'laptop', clis: [] },
      { code: valid.code, hostName: 'laptop', clis: ['claude', 'claude'] },
    ]) {
      expect((await post('/redeem', body)).status).toBe(400);
    }
    expect(state.redeemPairing).not.toHaveBeenCalled();
  });

  it('fails inside the transaction, so the code is not burnt by our error', async () => {
    state.createAgent.mockRejectedValue(new Error('database down'));
    const response = await post('/redeem', valid);
    expect(response.status).toBe(500);
    expect(state.createLink).not.toHaveBeenCalled();
  });

  it('rate limits attempts per address, used codes or not', async () => {
    state.redeemPairing.mockResolvedValue(null);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post('/redeem', valid)).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(state.redeemPairing).toHaveBeenCalledTimes(10);
  });
});

describe('GET and DELETE /agents/external', () => {
  it('lists the agents with live presence', async () => {
    state.online.add('a2');
    const body = (await (await fetch(`${base}/agents/external`)).json()) as {
      agents: { agentId: string; online: boolean }[];
    };
    expect(body.agents.map((a) => [a.agentId, a.online])).toEqual([
      ['a1', false],
      ['a2', true],
    ]);
  });

  it('revokes and disconnects, and 404s when it is not the caller’s', async () => {
    const ok = await fetch(`${base}/agents/external/agent-1`, { method: 'DELETE' });
    expect(ok.status).toBe(204);
    expect(state.revoke).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'agent-1');
    expect(state.disconnect).toHaveBeenCalledWith('agent-1', { reason: 'revoked' });
    expect(state.deleteAgent).toHaveBeenCalledWith(expect.anything(), 'agent-1');

    state.revoke.mockResolvedValue(false);
    state.disconnect.mockClear();
    state.deleteAgent.mockClear();
    const missing = await fetch(`${base}/agents/external/agent-9`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(state.disconnect).not.toHaveBeenCalled();
    expect(state.deleteAgent).not.toHaveBeenCalled();
  });
});

describe('sessions: POST /agents/external/:agentId/sessions and GET …/folders', () => {
  const open = (agentId: string, body: unknown) => post(`/${agentId}/sessions`, body);

  beforeEach(() => {
    state.openSession.mockImplementation(async (_db, input) => ({
      cwd: input.cwd,
      agentId: input.agentId,
      ownerOxyUserId: input.ownerOxyUserId,
    }));
    state.folders.mockResolvedValue(['/home/ana/app', '/home/ana/api']);
  });

  it('records the folder a conversation with the caller’s agent works in', async () => {
    const response = await open('agent-1', { conversationId: 'c-1', cwd: '/home/ana/app' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ conversationId: 'c-1', cwd: '/home/ana/app' });
    expect(state.openSession).toHaveBeenCalledWith(expect.anything(), {
      conversationId: 'c-1',
      agentId: 'agent-1',
      ownerOxyUserId: 'owner-1',
      cwd: '/home/ana/app',
    });
  });

  it('accepts home-relative and drive paths, and refuses anything else', async () => {
    for (const cwd of ['~/code', '~', 'C:\\Users\\ana\\code', 'D:/code']) {
      expect((await open('agent-1', { conversationId: 'c', cwd })).status).toBe(201);
    }
    state.openSession.mockClear();
    for (const cwd of ['relative/path', '../up', '', 'a'.repeat(2000), '/ok\0bad']) {
      expect((await open('agent-1', { conversationId: 'c', cwd })).status).toBe(400);
    }
    expect((await open('agent-1', { cwd: '/x' })).status).toBe(400);
    expect((await open('agent-1', { conversationId: 'c', cwd: '/x', extra: 1 })).status).toBe(400);
    expect(state.openSession).not.toHaveBeenCalled();
  });

  it('404s an agent that is not the caller’s, and never writes', async () => {
    state.findLink.mockResolvedValue({ agentId: 'agent-1', ownerOxyUserId: 'someone-else' });
    expect((await open('agent-1', { conversationId: 'c', cwd: '/x' })).status).toBe(404);
    state.findLink.mockResolvedValue(undefined);
    expect((await open('agent-9', { conversationId: 'c', cwd: '/x' })).status).toBe(404);
    expect(state.openSession).not.toHaveBeenCalled();
  });

  it('does not let a conversation of another agent or person be taken over', async () => {
    state.openSession.mockResolvedValue({
      cwd: '/theirs',
      agentId: 'agent-2',
      ownerOxyUserId: 'owner-1',
    });
    expect((await open('agent-1', { conversationId: 'c', cwd: '/x' })).status).toBe(409);
  });

  it('lists the recent folders of the caller’s agent only', async () => {
    const ok = await fetch(`${base}/agents/external/agent-1/folders`);
    expect(await ok.json()).toEqual({ folders: ['/home/ana/app', '/home/ana/api'] });
    expect(state.folders).toHaveBeenCalledWith(expect.anything(), {
      agentId: 'agent-1',
      ownerOxyUserId: 'owner-1',
      limit: 10,
    });
    state.findLink.mockResolvedValue({ agentId: 'agent-1', ownerOxyUserId: 'someone-else' });
    expect((await fetch(`${base}/agents/external/agent-1/folders`)).status).toBe(404);
  });
});

describe('terminal sessions (ADR 0043 §4)', () => {
  const open = (body: unknown) => post('/agent-1/sessions', body);
  const list = () => fetch(`${base}/agents/external/agent-1/terminal-sessions`);

  beforeEach(() => {
    state.openSession.mockImplementation(async (_db, input) => ({
      cwd: input.cwd,
      agentId: input.agentId,
      ownerOxyUserId: input.ownerOxyUserId,
    }));
  });

  it('opens a conversation on a terminal session of the CLI', async () => {
    const response = await open({
      conversationId: 'c-1',
      cwd: '/w',
      resumeId: 'terminal-session-1',
    });
    expect(response.status).toBe(201);
    expect(state.openSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cliSessionId: 'terminal-session-1' }),
    );
  });

  it('refuses a resume id that is not a session id, before anything is stored', async () => {
    for (const resumeId of ['--dangerous; rm -rf', 'short', 'has space in it', 'x'.repeat(200)]) {
      expect((await open({ conversationId: 'c-1', cwd: '/w', resumeId })).status).toBe(400);
    }
    expect(state.openSession).not.toHaveBeenCalled();
  });

  it('lists what the agent’s CLI has, for its owner only', async () => {
    state.listTerminal.mockResolvedValue([
      { id: 's-0000001', cwd: '/w', title: 't', updatedAt: 1 },
    ]);
    const ok = await list();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      sessions: [{ id: 's-0000001', cwd: '/w', title: 't', updatedAt: 1 }],
    });
    expect(state.listTerminal).toHaveBeenCalledWith('agent-1');

    state.listTerminal.mockClear();
    state.findLink.mockResolvedValue({ agentId: 'agent-1', ownerOxyUserId: 'someone-else' });
    expect((await list()).status).toBe(404);
    expect(state.listTerminal).not.toHaveBeenCalled();
  });

  it('says 503, not an empty list, when the computer cannot answer', async () => {
    state.listTerminal.mockRejectedValue(new Error('offline'));
    expect((await list()).status).toBe(503);
  });
});

describe('POST /agents/external/:agentId/approvals/:requestId (ADR 0043 §5)', () => {
  const REQUEST = '11111111-2222-4333-8444-555555555555';
  const answer = (body: unknown, requestId = REQUEST, agentId = 'agent-1') =>
    post(`/${agentId}/approvals/${requestId}`, body);

  it('hands the owner’s answer to the daemon that asked', async () => {
    state.online.add('agent-1');
    expect((await answer({ decision: 'allow' })).status).toBe(204);
    expect(state.answerApproval).toHaveBeenCalledWith('agent-1', REQUEST, 'allow');
    expect((await answer({ decision: 'deny' })).status).toBe(204);
    expect(state.answerApproval).toHaveBeenLastCalledWith('agent-1', REQUEST, 'deny');
  });

  it('answers for nobody else’s agent, and for none whose computer is gone', async () => {
    state.online.add('agent-1');
    state.findLink.mockResolvedValue({ agentId: 'agent-1', ownerOxyUserId: 'someone-else' });
    expect((await answer({ decision: 'allow' })).status).toBe(404);
    state.findLink.mockResolvedValue(undefined);
    expect((await answer({ decision: 'allow' })).status).toBe(404);
    state.findLink.mockResolvedValue({ agentId: 'agent-1', ownerOxyUserId: 'owner-1' });
    state.online.clear();
    expect((await answer({ decision: 'allow' })).status).toBe(404);
    expect(state.answerApproval).not.toHaveBeenCalled();
  });

  it('refuses a decision other than allow or deny, extra fields, and an id that is not a request id', async () => {
    state.online.add('agent-1');
    for (const body of [
      { decision: 'maybe' },
      { decision: 'allow', extra: 1 },
      {},
      { decision: 'expired' },
    ]) {
      expect((await answer(body)).status).toBe(400);
    }
    expect((await answer({ decision: 'allow' }, 'not-a-request-id')).status).toBe(400);
    expect(state.answerApproval).not.toHaveBeenCalled();
  });
});
