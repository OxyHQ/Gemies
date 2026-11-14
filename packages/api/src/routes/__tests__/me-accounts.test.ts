/**
 * `/me/accounts` — a person's connected accounts (ADR 0035 as amended). Under test: that every
 * route is scoped to the caller, that an account is connected once and granted to nobody until the
 * person chooses, that a gemie can be granted only by someone who may grant it (`loadGrantableGemie`),
 * that the answering gemie is granted the account and its task names that gemie's actor (Alia's lane
 * is the person's own, a persona acts as its account), that revoking the answering gemie revokes the
 * task, that only the platforms the gateway runs can be connected, and that a list shows each
 * account as its session is now, with its grants.
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
  grants: [] as Array<Record<string, unknown>>,
  answering: null as string | null,
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
  grant: vi.fn(),
  revokeGrant: vi.fn(),
  setAnswering: vi.fn(),
  createTask: vi.fn(),
  revokeTask: vi.fn(),
  loadGrantable: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'person-1' }, accessToken: 'PERSON-TOKEN' });
    next();
  },
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/agents/agentRepository.js', () => ({
  listActiveAgentsByAuthor: vi.fn(async () => [
    { _id: 'persona-1', identity: PERSONA.identity, tagline: '' },
    // A gemie with no Oxy account can use no connected account (ADR 0036).
    { _id: 'external-1', identity: { source: 'local', name: 'Desk', color: '#fff' }, tagline: '' },
  ]),
}));
vi.mock('../../lib/agent-identity.js', () => ({
  attachAgentIdentities: vi.fn(async (rows: Array<{ _id: string }>) =>
    rows.map((row) => ({ ...row, name: row._id === 'persona-1' ? 'Scout' : null, handle: null })),
  ),
  agentPromptName: (agent: { name: string | null; handle: string | null }) =>
    agent.name ?? agent.handle ?? 'Agent',
}));
vi.mock('../../domain/alia-gemie.js', () => ({ ALIA_GEMIE_ID: 'alia-gemie' }));
vi.mock('../../lib/agent-account.js', () => ({
  loadGrantableGemie: state.loadGrantable,
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../db/integrations/connectedAccountRepository.js', () => ({
  findPersonAccount: state.find,
  listPersonAccounts: state.list,
  listPersonAccountGrants: vi.fn(async () => state.grants),
  findAnsweringGemieId: vi.fn(async () => state.answering),
  createPendingConnectedAccount: state.create,
  deleteConnectedAccount: state.remove,
  setConnectedAccountSession: state.setSession,
  setConnectedAccountSessionState: state.setSessionState,
  setConnectedAccountReplies: state.setReplies,
  setConnectedAccountTask: state.saveTask,
  grantConnectedAccount: state.grant,
  revokeConnectedAccountGrant: state.revokeGrant,
  setAnsweringGemie: state.setAnswering,
  listAccountsAnsweredBy: vi.fn(async () => []),
}));
vi.mock('../../lib/oxy-task-authority.js', () => ({
  revokeOxyTask: state.revokeTask,
  // `bindOxyTask`'s contract (its own suite proves it): mint, write, and release the loser or the
  // replaced task only after the write.
  bindOxyTask: async (
    input: unknown,
    write: (task: { id: string; expiresAt: Date }) => Promise<{ replaced: string | null } | null>,
  ) => {
    const task = { id: await state.createTask(input), expiresAt: new Date('2027-11-14T00:00:00Z') };
    const written = await write(task);
    if (!written) {
      await state.revokeTask(task.id);
      return null;
    }
    if (written.replaced) await state.revokeTask(written.replaced);
    return task;
  },
}));
vi.mock('../../lib/integrations-client.js', () => ({
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
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { channels: child, agents: child, general: child } };
});

const { default: router } = await import('../me-accounts.js');

const app = express();
app.use(express.json());
app.use('/me/accounts', router);
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
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
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
  state.loadGrantable.mockImplementation(async () => state.loaded);
  state.account = {
    id: 'account-1',
    _id: 'account-1',
    platform: 'whatsapp',
    status: 'connected',
    sessionId: 'session-1',
    oxyTaskId: 'old-task',
    oxyTaskState: 'active',
  };
  state.grants = [];
  state.answering = null;
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
    async (_db: unknown, id: string, _person: unknown, patch: Record<string, unknown>) => ({
      ...state.account,
      id,
      ...patch,
    }),
  );
  state.revokeGrant.mockResolvedValue({ answered: false });
  state.remove.mockResolvedValue(undefined);
  state.saveTask.mockResolvedValue(true);
  state.createTask.mockResolvedValue('new-task');
  state.revokeTask.mockResolvedValue(undefined);
});

describe('the person’s accounts', () => {
  it('lists the caller’s accounts with their grants, the gemies to grant and the platforms', async () => {
    answer('GET /accounts/whatsapp/sessions/session-1/status', { status: 'connected' });
    state.grants = [
      { accountId: 'account-1', agentId: 'alia-gemie', answers: false, identity: ALIA.identity },
      { accountId: 'account-1', agentId: 'persona-1', answers: true, identity: PERSONA.identity },
    ];
    const { status, body } = await call('GET', '/me/accounts');
    expect(status).toBe(200);
    expect(state.list).toHaveBeenCalledWith({}, 'person-1');
    expect(body.platforms).toEqual(['whatsapp', 'telegram']);
    expect(body.gemies).toEqual([
      { id: 'alia-gemie', name: 'Alia' },
      { id: 'persona-1', name: 'Scout' },
    ]);
    const [account] = body.accounts as Array<Record<string, unknown>>;
    expect(account).toMatchObject({
      id: 'account-1',
      gemieIds: ['alia-gemie', 'persona-1'],
      answeringGemieId: 'persona-1',
    });
    // The provider session and the Oxy task are the server's, never the panel's.
    expect(account).not.toHaveProperty('sessionId');
    expect(account).not.toHaveProperty('oxyTaskId');
  });

  it('never reaches an account of somebody else', async () => {
    state.account = null;
    expect((await call('DELETE', '/me/accounts/someone-elses')).status).toBe(404);
    expect((await call('PUT', '/me/accounts/someone-elses/gemies/persona-1')).status).toBe(404);
    expect(state.find).toHaveBeenCalledWith({}, 'someone-elses', 'person-1');
    expect(state.revokeTask).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
  });

  it('stores what the gateway reports when a session moved: unlinked from the phone', async () => {
    answer('GET /accounts/whatsapp/sessions/session-1/status', {
      status: 'logged-out',
      phoneNumber: '+34600',
    });
    const { body } = await call('GET', '/me/accounts');
    expect(state.setSessionState).toHaveBeenCalledWith({}, 'account-1', {
      status: 'logged-out',
      phoneNumber: '+34600',
    });
    expect(body.accounts).toEqual([expect.objectContaining({ status: 'logged-out' })]);
  });

  it('answers the stored account when the gateway cannot be asked', async () => {
    const { status, body } = await call('GET', '/me/accounts');
    expect(status).toBe(200);
    expect(state.setSessionState).not.toHaveBeenCalled();
    expect(body.accounts).toEqual([expect.objectContaining({ status: 'connected' })]);
  });
});

describe('connecting an account', () => {
  it('connects WhatsApp for the person, granted to nobody and with no task yet', async () => {
    const { status, body } = await call('POST', '/me/accounts', { platform: 'whatsapp' });
    expect(status).toBe(201);
    expect(body).toEqual({ accountId: 'new-account', qr: 'QR-1' });
    expect(state.create).toHaveBeenCalledWith({}, { oxyUserId: 'person-1', platform: 'whatsapp' });
    expect(state.setSession).toHaveBeenCalledWith({}, 'new-account', 'wa-session');
    expect(state.createTask).not.toHaveBeenCalled();
    expect(state.grant).not.toHaveBeenCalled();
  });

  it('refuses a platform this deployment does not run, before anything is created', async () => {
    answer('GET /accounts/platforms', { platforms: ['whatsapp'] });
    const { status, body } = await call('POST', '/me/accounts', { platform: 'telegram' });
    expect(status).toBe(409);
    expect(body.code).toBe('platform_unavailable');
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each(['gmail', 'signal', 'constructor'])('refuses %s', async (platform) => {
    expect((await call('POST', '/me/accounts', { platform })).status).toBe(400);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('says what the gateway said, and forgets the placeholder', async () => {
    answer('POST /accounts/whatsapp/sessions/connect', { error: 'Timed out waiting for QR' }, 500);
    const { status, body } = await call('POST', '/me/accounts', { platform: 'whatsapp' });
    // A 503 the panel can read, never a 502 a CDN serves without CORS headers.
    expect(status).toBe(503);
    expect(body).toEqual({
      error: 'Timed out waiting for QR',
      code: 'accounts_gateway_unavailable',
    });
    expect(state.remove).toHaveBeenCalledWith({}, 'new-account');
  });

  it('offers nothing when the gateway predates the contract (no /accounts/platforms)', async () => {
    state.gateway.delete('GET /accounts/platforms');
    const { body } = await call('GET', '/me/accounts');
    expect(body.platforms).toEqual([]);
    expect((await call('POST', '/me/accounts', { platform: 'whatsapp' })).status).toBe(409);
    expect(state.create).not.toHaveBeenCalled();
  });
});

describe('which gemies may use it', () => {
  it('grants a gemie the person may grant', async () => {
    expect((await call('PUT', '/me/accounts/account-1/gemies/persona-1')).status).toBe(204);
    expect(state.loadGrantable).toHaveBeenCalledWith(
      {},
      { agentId: 'persona-1', oxyUserId: 'person-1', accessToken: 'PERSON-TOKEN' },
    );
    expect(state.grant).toHaveBeenCalledWith({}, 'account-1', 'persona-1');
  });

  it('refuses a gemie the person may not grant, and grants nothing', async () => {
    state.loaded = { ok: false, refusal: 'agent_not_found' };
    const { status, body } = await call('PUT', '/me/accounts/account-1/gemies/somebody-elses');
    expect(status).toBe(404);
    expect(body.code).toBe('gemie_not_grantable');
    expect(state.grant).not.toHaveBeenCalled();
  });

  it('revokes a grant; the answering gemie’s revocation revokes the account’s task too', async () => {
    expect((await call('DELETE', '/me/accounts/account-1/gemies/alia-gemie')).status).toBe(204);
    expect(state.revokeGrant).toHaveBeenCalledWith({}, 'account-1', 'alia-gemie');
    expect(state.revokeTask).not.toHaveBeenCalled();

    state.revokeGrant.mockResolvedValueOnce({ answered: true });
    expect((await call('DELETE', '/me/accounts/account-1/gemies/persona-1')).status).toBe(204);
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
  });
});

describe('who answers it', () => {
  it('makes a persona answer it, with a task the persona acts on as its account', async () => {
    const { status } = await call('PATCH', '/me/accounts/account-1', {
      answeringGemieId: 'persona-1',
    });
    expect(status).toBe(200);
    expect(state.setAnswering).toHaveBeenCalledWith({}, 'account-1', 'persona-1');
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
    expect(state.createTask).toHaveBeenCalledWith({
      accessToken: 'PERSON-TOKEN',
      effectiveAccountId: 'person-1',
      actor: { type: 'agent', accountId: 'bot-1' },
      origin: { kind: 'automation', id: 'channel:account-1' },
    });
  });

  it('makes Alia answer it on the person’s own lane', async () => {
    state.loaded = { ok: true, agent: ALIA };
    await call('PATCH', '/me/accounts/account-1', { answeringGemieId: 'alia-gemie' });
    expect(state.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'alia', ownerAccountId: 'person-1' } }),
    );
  });

  it('makes nobody answer it: the task is revoked and none is granted', async () => {
    await call('PATCH', '/me/accounts/account-1', { answeringGemieId: null });
    expect(state.setAnswering).toHaveBeenCalledWith({}, 'account-1', null);
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
    expect(state.createTask).not.toHaveBeenCalled();
  });

  it('refuses a gemie the person may not grant, and changes nothing', async () => {
    state.loaded = { ok: false, refusal: 'not_permitted' };
    const { status } = await call('PATCH', '/me/accounts/account-1', {
      answeringGemieId: 'somebody-elses',
    });
    expect(status).toBe(403);
    expect(state.setAnswering).not.toHaveBeenCalled();
    expect(state.revokeTask).not.toHaveBeenCalled();
  });

  it('saves its replies for the caller’s account only', async () => {
    const { status } = await call('PATCH', '/me/accounts/account-1', {
      replies: 'chosen',
      replyChatIds: ['c1@s.whatsapp.net'],
      groupReplies: 'never',
    });
    expect(status).toBe(200);
    expect(state.setReplies).toHaveBeenCalledWith({}, 'account-1', 'person-1', {
      replies: 'chosen',
      replyChatIds: ['c1@s.whatsapp.net'],
      groupReplies: 'never',
    });
    expect(state.setAnswering).not.toHaveBeenCalled();
  });

  it('refuses a value it does not know', async () => {
    expect((await call('PATCH', '/me/accounts/account-1', { replies: 'friends' })).status).toBe(
      400,
    );
    expect(state.setReplies).not.toHaveBeenCalled();
  });
});

describe('an account’s task', () => {
  it('renews it for the answering gemie, revoking the old one only once the new one is held', async () => {
    state.answering = 'persona-1';
    const { status, body } = await call('POST', '/me/accounts/account-1/reauthorize');
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, oxyTaskState: 'active' });
    expect(state.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'agent', accountId: 'bot-1' } }),
    );
    // Swapped in place of the task it held, with Oxy's expiry, then the old one released.
    expect(state.saveTask).toHaveBeenCalledWith(
      {},
      'account-1',
      { id: 'new-task', expiresAt: new Date('2027-11-14T00:00:00Z') },
      'old-task',
    );
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
    expect(state.saveTask.mock.invocationCallOrder[0]).toBeLessThan(
      state.revokeTask.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('has none to renew when nobody answers the account', async () => {
    const { status, body } = await call('POST', '/me/accounts/account-1/reauthorize');
    expect(status).toBe(409);
    expect(body.code).toBe('no_answering_gemie');
    expect(state.createTask).not.toHaveBeenCalled();
  });

  it('revokes a losing concurrent task and keeps the one the account still holds', async () => {
    state.answering = 'persona-1';
    state.saveTask.mockResolvedValueOnce(false);
    expect((await call('POST', '/me/accounts/account-1/reauthorize')).status).toBe(503);
    expect(state.revokeTask).toHaveBeenCalledWith('new-task');
    expect(state.revokeTask).not.toHaveBeenCalledWith('old-task');
  });
});

describe('removing an account', () => {
  it('revokes its task, has the gateway forget its session, and deletes it', async () => {
    answer('DELETE /accounts/whatsapp/sessions/session-1', null, 204);
    expect((await call('DELETE', '/me/accounts/account-1')).status).toBe(200);
    expect(state.revokeTask).toHaveBeenCalledWith('old-task');
    expect(state.gatewayCalls).toContain('DELETE /accounts/whatsapp/sessions/session-1');
    expect(state.remove).toHaveBeenCalledWith({}, 'account-1');
  });
});
