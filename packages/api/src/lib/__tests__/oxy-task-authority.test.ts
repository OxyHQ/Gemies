import { beforeEach, describe, expect, it, vi } from 'vitest';
const authority = vi.hoisted(() => ({ createTask: vi.fn(), revokeTask: vi.fn() }));
vi.mock('../oxy.js', () => ({
  get oxy() {
    return { agency: authority };
  },
}));
import { createOxyTask, revokeOxyTask } from '../oxy-task-authority.js';
beforeEach(() => {
  vi.resetAllMocks();
  authority.createTask.mockResolvedValue({
    id: 'task-1',
    requesterAccountId: 'requester',
    effectiveAccountId: 'requester',
  });
  authority.revokeTask.mockResolvedValue(undefined);
});
describe('original requester task authority', () => {
  it('binds a durable background goal to the requester and selected bot, never its owner', async () => {
    expect(
      await createOxyTask({
        accessToken: 'requester-session',
        effectiveAccountId: 'requester',
        actorAccountId: 'bot-not-owned-by-requester',
        origin: { kind: 'goal', id: 'session-1' },
      }),
    ).toBe('task-1');
    const [terms, proof] = authority.createTask.mock.calls[0];
    expect(terms).toMatchObject({
      origin: { kind: 'goal', id: 'session-1' },
      actor: { type: 'agent', accountId: 'bot-not-owned-by-requester' },
      effectiveAccountId: 'requester',
    });
    expect(Date.parse(terms.expiresAt) - Date.now()).toBeGreaterThan(360 * 86400000);
    expect(proof).toEqual({ requesterToken: 'requester-session' });
    expect(terms).not.toHaveProperty('scopes');
  });
  it('keeps ephemeral requests inside the API lifetime and revokes on cancellation', async () => {
    await createOxyTask({
      accessToken: 'requester-session',
      effectiveAccountId: 'requester',
      actor: { type: 'alia', ownerAccountId: 'requester' },
      origin: { kind: 'request', id: 'turn-1' },
    });
    expect(
      Date.parse(authority.createTask.mock.calls[0][0].expiresAt) - Date.now(),
    ).toBeLessThanOrEqual(10 * 60000);
    await revokeOxyTask('task-1');
    expect(authority.revokeTask).toHaveBeenCalledWith('task-1');
  });
  it('never outlives the requester bearer a request task is minted on', async () => {
    // Oxy refuses a request task that outlives its requester (400 "Task lifetime is out of
    // range"): a room member minted on a token with three minutes left got no task at all.
    const exp = Math.floor(Date.now() / 1000) + 180;
    const claims = Buffer.from(JSON.stringify({ exp, userId: 'requester' })).toString('base64url');
    await createOxyTask({
      accessToken: `header.${claims}.signature`,
      effectiveAccountId: 'requester',
      actorAccountId: 'bot',
      origin: { kind: 'request', id: 'room:1:bot' },
    });
    expect(Date.parse(authority.createTask.mock.calls[0][0].expiresAt)).toBe(exp * 1000);
  });
  it('keeps the ten-minute request lifetime for a bearer that lives longer or does not say', async () => {
    const claims = Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString(
      'base64url',
    );
    for (const accessToken of [`h.${claims}.s`, 'opaque-session', 'h.not-json.s']) {
      authority.createTask.mockClear();
      const before = Date.now();
      await createOxyTask({
        accessToken,
        effectiveAccountId: 'requester',
        actorAccountId: 'bot',
        origin: { kind: 'request', id: 'turn' },
      });
      const lifetime = Date.parse(authority.createTask.mock.calls[0][0].expiresAt) - before;
      expect(lifetime).toBeGreaterThanOrEqual(10 * 60000);
      expect(lifetime).toBeLessThan(10 * 60000 + 1000);
    }
  });
  it('retains the human requester of a managed organization session', async () => {
    authority.createTask.mockResolvedValue({
      id: 'managed-task',
      requesterAccountId: 'human-operator',
      effectiveAccountId: 'organization',
    });
    expect(
      await createOxyTask({
        accessToken: 'managed-session',
        effectiveAccountId: 'organization',
        actor: { type: 'alia', ownerAccountId: 'organization' },
        origin: { kind: 'automation', id: 'channel-organization' },
      }),
    ).toBe('managed-task');
    expect(authority.revokeTask).not.toHaveBeenCalled();
    expect(authority.createTask.mock.calls[0][0].effectiveAccountId).toBe('organization');
  });
  it('retires an unexpected account binding and refuses to store it', async () => {
    authority.createTask.mockResolvedValue({
      id: 'wrong-task',
      requesterAccountId: 'bot-owner',
      effectiveAccountId: 'bot-owner',
    });
    await expect(
      createOxyTask({
        accessToken: 'requester-session',
        effectiveAccountId: 'requester',
        actorAccountId: 'bot',
        origin: { kind: 'goal', id: 'goal' },
      }),
    ).rejects.toThrow('originating account');
    expect(authority.revokeTask).toHaveBeenCalledWith('wrong-task');
  });
});
