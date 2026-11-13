/**
 * `/agents/:id/accounts` — a gemie's connected accounts (ADR 0035). Under test: who may manage them
 * (whoever may act as the gemie), that every read is scoped to the caller AND the gemie, whose actor
 * the account's Oxy task names (Alia's lane is the person's own, a persona acts as its account), that
 * only the platforms the gateway runs can be linked, that a list shows each account as its session
 * is now, and who the gemie answers.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ALIA = {
  _id: 'alia-gemie',
  reach: 'person',
  identity: { source: 'oxy', oxyAccountId: 'pending' },
  ownerOxyAccountId: null,
};
const PERSONA = {
  _id: 'persona-1',
  reach: 'grants',
  identity: { source: 'oxy', oxyAccountId: 'bot-1' },
  ownerOxyAccountId: 'person-1',
};

const state = vi.hoisted(() => ({
  loaded: { ok: true } as { ok: boolean; agent?: unknown; refusal?: string },
  account: null as Record<string, unknown> | null,
  /** The gateway's answers, by `METHOD path`. */
  gateway: new Map<string, { status: number; body: unknown }>(),
  gatewayCalls: [] as string[],
  find: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  setSession: vi.fn(),
  setSessionState: vi.fn(),
  setReplies: vi.fn(),
  saveTask: vi.fn(),
  createTask: vi.fn(),
  revokeTask: vi.fn(),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'person-1' }, accessToken: 'PERSON-TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/agent-account.js', () => ({
  loadAgentForAccounts: vi.fn(async () => state.loaded),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../../db/integrations/connectedAccountRepository.js', () => ({
  findGemieAccount: state.find,
  listGemieAccounts: state.list,
  listAccountsOfGemie: vi.fn(async () => []),
  createPendingConnectedAccount: state.create,
  deleteConnectedAccount: state.remove,
  setConnectedAccountSession: state.setSession,
  setConnectedAccountSessionState: state.setSessionState,
  setConnectedAccountReplies: state.setReplies,
  setConnectedAccountTask: state.saveTask,
}));
vi.mock('../../../lib/oxy-task-authority.js', () => ({
  createOxyTask: state.createTask,
  revokeOxyTask: state.revokeTask,
}));
vi.mock('../../../lib/integrations-client.js', () => ({
  integrationsFetch: vi.fn(async (_account: string, path: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${path}`;
    state.gatewayCalls.push(key);
    const answer = state.gateway.get(key) ?? { status: 404, body: { error: 'Session not found' } };
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { channels: child, agents: child, general: child } };
});

const { default: router } = await import('../accounts.js');

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

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const answer = (key: string, body: unknown, status = 200) =>
  state.gateway.set(key, { status, body });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('INTEGRATIONS_URL', 'https://integrations.example.test');
  state.gateway.clear();
  state.gatewayCalls = [];
  answer('GET /accounts/platforms', { platforms: ['whatsapp', 'telegram'] });
  answer('POST /accounts/whatsapp/sessions/connect', { sessionId: 'wa-session', qr: 'QR-1' });
  answer('POST /accounts/telegram/sessions/connect', { sessionId: 'tg-session', qr: 'tg://login' });
  state.loaded = { ok: true, agent: PERSONA };
  state.account = {
    id: 'account-1',
    agentId: 'persona-1',
    platform: 'whatsapp',
    status: 'connected',
    sessionId: 'session-1',
    oxyTaskId: 'old-task',
    oxyTaskState: 'active',
  };
  state.find.mockImplementation(async () => (state.account ? { ...state.account } : null));
  state.list.mockImplementation(async () => (state.account ? [{ ...state.account }] : []));
  state.create.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    id: 'new-account',
    ...input,
    status: 'qr-pending',
    oxyTaskId: null,
    oxyTaskState: 'reauth_required',
  }));
  state.setSessionState.mockImplementation(
    async (_db: unknown, id: string, patch: Record<string, unknown>) => ({
      ...state.account,
      id,
      ...patch,
    }),
  );
  state.setReplies.mockImplementation(
    async (_db: unknown, id: string, _scope: unknown, patch: Record<string, unknown>) => ({
      ...state.account,
      id,
      ...patch,
    }),
  );
  state.saveTask.mockResolvedValue(true);
  state.createTask.mockResolvedValue('new-task');
  state.revokeTask.mockResolvedValue(undefined);
});

describe('who manages a gemie’s accounts', () => {
  it('lists only the caller’s accounts on this gemie, and the platforms the gateway runs', async () => {
    answer('GET /accounts/whatsapp/sessions/session-1/status', { status: 'connected' });
    const { status, body } = await call('GET', '/agents/persona-1/accounts');
    expect(status).toBe(200);
    expect(state.list).toHaveBeenCalledWith({}, { agentId: 'persona-1', oxyUserId: 'person-1' });
    expect(body.platforms).toEqual(['whatsapp', 'telegram']);
  });

  it('answers a gemie the caller may not act as as not found, and touches nothing', async () => {
    state.loaded = { ok: false, refusal: 'agent_not_found' };
    expect((await call('GET', '/agents/persona-1/accounts')).status).toBe(404);
    expect(
      (await call('POST', '/agents/persona-1/accounts', { platform: 'whatsapp' })).status,
    ).toBe(404);
    expect(state.list).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('never reaches an account outside the caller’s scope on the gemie', async () => {
    state.account = null;
    expect((await call('DELETE', '/agents/persona-1/accounts/someone-elses')).status).toBe(404);
    expect(state.find).toHaveBeenCalledWith({}, 'someone-elses', {
      agentId: 'persona-1',
      oxyUserId: 'person-1',
    });
    expect(state.revokeTask).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });
});

describe('a list shows each account as its session is now', () => {
  it('stores what the gateway reports when the session moved: unlinked from the phone', async () => {
    answer('GET /accounts/whatsapp/sessions/session-1/status', {
      status: 'logged-out',
      phoneNumber: '+34600',
    });
    const { body } = await call('GET', '/agents/persona-1/accounts');
    expect(state.setSessionState).toHaveBeenCalledWith({}, 'account-1', {
      status: 'logged-out',
      phoneNumber: '+34600',
    });
    expect(body.accounts).toEqual([expect.objectContaining({ status: 'logged-out' })]);
  });

  it('answers the stored account when the gateway cannot be asked', async () => {
    const { status, body } = await call('GET', '/agents/persona-1/accounts');
    expect(status).toBe(200);
    expect(state.setSessionState).not.toHaveBeenCalled();
    expect(body.accounts).toEqual([expect.objectContaining({ status: 'connected' })]);
  });
});

describe('linking an account', () => {
  it('links WhatsApp to the gemie, with a task the persona acts on as its account', async () => {
    const { status, body } = await call('POST', '/agents/persona-1/accounts', {
      platform: 'whatsapp',
    });
    expect(status).toBe(201);
    expect(body).toEqual({ accountId: 'new-account', qr: 'QR-1' });
    expect(state.create).toHaveBeenCalledWith(
      {},
      { agentId: 'persona-1', oxyUserId: 'person-1', platform: 'whatsapp' },
    );
    expect(state.createTask).toHaveBeenCalledWith({
      accessToken: 'PERSON-TOKEN',
      effectiveAccountId: 'person-1',
      actor: { type: 'agent', accountId: 'bot-1' },
      origin: { kind: 'automation', id: 'channel:new-account' },
    });
    expect(state.setSession).toHaveBeenCalledWith({}, 'new-account', 'wa-session');
  });

  it('links Telegram to Alia on the person’s own lane', async () => {
    state.loaded = { ok: true, agent: ALIA };
    expect(
      (await call('POST', '/agents/alia-gemie/accounts', { platform: 'telegram' })).status,
    ).toBe(201);
    expect(state.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'alia', ownerAccountId: 'person-1' } }),
    );
    expect(state.gatewayCalls).toContain('POST /accounts/telegram/sessions/connect');
  });

  it('refuses a platform this deployment does not run, before anything is created', async () => {
    answer('GET /accounts/platforms', { platforms: ['whatsapp'] });
    const { status, body } = await call('POST', '/agents/persona-1/accounts', {
      platform: 'telegram',
    });
    expect(status).toBe(409);
    expect(body.code).toBe('platform_unavailable');
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each(['gmail', 'signal', 'constructor'])('refuses %s', async (platform) => {
    expect((await call('POST', '/agents/persona-1/accounts', { platform })).status).toBe(400);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('says what the gateway said, and forgets the placeholder and its task', async () => {
    answer('POST /accounts/whatsapp/sessions/connect', { error: 'Timed out waiting for QR' }, 500);
    const { status, body } = await call('POST', '/agents/persona-1/accounts', {
      platform: 'whatsapp',
    });
    // A 503 the panel can read, never a 502 a CDN serves without CORS headers.
    expect(status).toBe(503);
    expect(body).toEqual({
      error: 'Timed out waiting for QR',
      code: 'accounts_gateway_unavailable',
    });
    expect(state.revokeTask).toHaveBeenCalledWith('new-task');
    expect(state.remove).toHaveBeenCalledWith({}, 'new-account');
  });
});

describe('a gateway that cannot be reached, or speaks an older contract', () => {
  it('offers nothing to link when the gateway predates the contract (no /accounts/platforms)', async () => {
    state.gateway.delete('GET /accounts/platforms');
    const { body } = await call('GET', '/agents/persona-1/accounts');
    expect(body.platforms).toEqual([]);
    expect(
      (await call('POST', '/agents/persona-1/accounts', { platform: 'whatsapp' })).status,
    ).toBe(409);
    expect(state.create).not.toHaveBeenCalled();
  });
});

describe('who the gemie answers', () => {
  it('saves a choice for the caller’s account only', async () => {
    const { status } = await call('PATCH', '/agents/persona-1/accounts/account-1', {
      replies: 'chosen',
      replyChatIds: ['c1@s.whatsapp.net'],
      groupReplies: 'never',
    });
    expect(status).toBe(200);
    expect(state.setReplies).toHaveBeenCalledWith(
      {},
      'account-1',
      { agentId: 'persona-1', oxyUserId: 'person-1' },
      { replies: 'chosen', replyChatIds: ['c1@s.whatsapp.net'], groupReplies: 'never' },
    );
  });

  it('refuses a value it does not know', async () => {
    expect(
      (await call('PATCH', '/agents/persona-1/accounts/account-1', { replies: 'friends' })).status,
    ).toBe(400);
    expect(state.setReplies).not.toHaveBeenCalled();
  });
});

describe('an account’s task', () => {
  it('renews it for the gemie, revoking the old one', async () => {
    const { status, body } = await call('POST', '/agents/persona-1/accounts/account-1/reauthorize');
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, oxyTaskState: 'active' });
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
    expect(state.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'agent', accountId: 'bot-1' } }),
    );
  });

  it('revokes a losing concurrent task instead of leaving an untracked root', async () => {
    state.saveTask.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await call('POST', '/agents/persona-1/accounts/account-1/reauthorize')).status).toBe(
      503,
    );
    expect(state.revokeTask).toHaveBeenCalledWith('new-task');
  });
});

describe('removing an account', () => {
  it('revokes its task, has the gateway forget its session, and deletes it', async () => {
    answer('DELETE /accounts/whatsapp/sessions/session-1', null, 204);
    expect((await call('DELETE', '/agents/persona-1/accounts/account-1')).status).toBe(200);
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
    expect(state.gatewayCalls).toContain('DELETE /accounts/whatsapp/sessions/session-1');
    expect(state.remove).toHaveBeenCalledWith({}, 'account-1');
  });
});
