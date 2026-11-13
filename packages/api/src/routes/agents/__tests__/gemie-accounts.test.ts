/**
 * `/agents/:id/accounts` — a gemie's connected accounts (ADR 0035). Under test: who may manage them
 * (whoever may act as the gemie), that every read is scoped to the caller AND the gemie, whose actor
 * the account's Oxy task names (Alia's lane is the person's own, a persona acts as its account), and
 * that only WhatsApp and Telegram can be linked.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ALIA = {
  _id: 'alia-gemie',
  reach: 'person',
  oxyAccountId: 'pending',
  ownerOxyAccountId: null,
};
const PERSONA = {
  _id: 'persona-1',
  reach: 'grants',
  oxyAccountId: 'bot-1',
  ownerOxyAccountId: 'person-1',
};

const state = vi.hoisted(() => ({
  loaded: { ok: true } as { ok: boolean; agent?: unknown; refusal?: string },
  account: null as Record<string, unknown> | null,
  find: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  setSession: vi.fn(),
  saveTask: vi.fn(),
  createTask: vi.fn(),
  revokeTask: vi.fn(),
  integrations: vi.fn(),
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
  setConnectedAccountStatus: vi.fn(),
  setConnectedAccountTask: state.saveTask,
}));
vi.mock('../../../lib/oxy-task-authority.js', () => ({
  createOxyTask: state.createTask,
  revokeOxyTask: state.revokeTask,
}));
vi.mock('../../../lib/integrations-client.js', () => ({ integrationsFetch: state.integrations }));
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

function jsonReply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('INTEGRATIONS_URL', 'https://integrations.example.test');
  state.loaded = { ok: true, agent: PERSONA };
  state.account = {
    id: 'account-1',
    agentId: 'persona-1',
    platform: 'whatsapp',
    sessionId: 'session-1',
    oxyTaskId: 'old-task',
    oxyTaskState: 'active',
  };
  state.find.mockImplementation(async () => (state.account ? { ...state.account } : null));
  state.list.mockResolvedValue([]);
  state.create.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    id: 'new-account',
    ...input,
    oxyTaskId: null,
    oxyTaskState: 'reauth_required',
  }));
  state.saveTask.mockResolvedValue(true);
  state.createTask.mockResolvedValue('new-task');
  state.revokeTask.mockResolvedValue(undefined);
  state.integrations.mockResolvedValue(
    jsonReply({ sessionId: 'wa-session', status: 'qr-pending', qr: 'QR-DATA' }),
  );
});

describe('who manages a gemie’s accounts', () => {
  it('lists only the caller’s accounts on this gemie', async () => {
    const { status } = await call('GET', '/agents/persona-1/accounts');
    expect(status).toBe(200);
    expect(state.list).toHaveBeenCalledWith({}, { agentId: 'persona-1', oxyUserId: 'person-1' });
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

describe('linking an account', () => {
  it('links WhatsApp to the gemie, with a task the persona acts on as its account', async () => {
    const { status, body } = await call('POST', '/agents/persona-1/accounts', {
      platform: 'whatsapp',
    });
    expect(status).toBe(201);
    expect(body).toEqual({ accountId: 'new-account', status: 'qr-pending', qr: 'QR-DATA' });
    expect(state.create).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentId: 'persona-1',
        oxyUserId: 'person-1',
        platform: 'whatsapp',
      }),
    );
    expect(state.createTask).toHaveBeenCalledWith({
      accessToken: 'PERSON-TOKEN',
      effectiveAccountId: 'person-1',
      actor: { type: 'agent', accountId: 'bot-1' },
      origin: { kind: 'automation', id: 'channel:new-account' },
    });
    expect(state.integrations).toHaveBeenCalledWith(
      'person-1',
      '/accounts/whatsapp/sessions/connect',
      expect.objectContaining({ method: 'POST' }),
    );
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
    expect(state.integrations).toHaveBeenCalledWith(
      'person-1',
      '/accounts/telegram-gateway/sessions/connect',
      expect.anything(),
    );
  });

  it.each(['gmail', 'signal', 'constructor'])('refuses %s', async (platform) => {
    expect((await call('POST', '/agents/persona-1/accounts', { platform })).status).toBe(400);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('forgets the placeholder and its task when the gateway does not open a session', async () => {
    state.integrations.mockResolvedValue(jsonReply({ error: 'down' }, 500));
    expect(
      (await call('POST', '/agents/persona-1/accounts', { platform: 'whatsapp' })).status,
    ).toBe(502);
    expect(state.revokeTask).toHaveBeenCalledWith('new-task');
    expect(state.remove).toHaveBeenCalledWith({}, 'new-account');
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
  it('revokes its task, ends its session and deletes it', async () => {
    state.integrations.mockResolvedValue(jsonReply({ success: true }));
    expect((await call('DELETE', '/agents/persona-1/accounts/account-1')).status).toBe(200);
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
    expect(state.integrations).toHaveBeenCalledWith(
      'person-1',
      '/accounts/whatsapp/sessions/session-1/disconnect',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(state.remove).toHaveBeenCalledWith({}, 'account-1');
  });
});
