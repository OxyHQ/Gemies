import { beforeEach, describe, expect, it, vi } from 'vitest';
const authority = vi.hoisted(() => ({ createTask: vi.fn(), revokeTask: vi.fn() }));
vi.mock('../oxy.js', () => ({
  get oxy() {
    return { agency: authority };
  },
}));
import {
  bindOxyTask,
  createOxyTask,
  isTaskAuthorityRefusal,
  mintOxyTask,
  revokeOxyTask,
} from '../oxy-task-authority.js';
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

describe('a standing binding’s task', () => {
  const input = {
    accessToken: 'requester-session',
    effectiveAccountId: 'requester',
    actor: { type: 'alia' as const, ownerAccountId: 'requester' },
    origin: { kind: 'automation' as const, id: 'channel:account-1' },
  };

  it('keeps the expiry Oxy answered, which may be earlier than the one asked for', async () => {
    authority.createTask.mockResolvedValue({
      id: 'task-1',
      requesterAccountId: 'requester',
      effectiveAccountId: 'requester',
      expiresAt: '2027-03-01T00:00:00.000Z',
    });
    expect(await mintOxyTask(input)).toEqual({
      id: 'task-1',
      expiresAt: new Date('2027-03-01T00:00:00.000Z'),
    });
  });

  it('releases the task it replaced only after the new one is written', async () => {
    const order: string[] = [];
    authority.revokeTask.mockImplementation(async (id: string) => {
      order.push(`revoke ${id}`);
    });
    const task = await bindOxyTask(input, async (minted) => {
      order.push(`write ${minted.id}`);
      return { replaced: 'old-task' };
    });
    expect(task?.id).toBe('task-1');
    expect(order).toEqual(['write task-1', 'revoke old-task']);
  });

  it('keeps the binding’s task when the binding changed, revoking only the new one', async () => {
    expect(await bindOxyTask(input, async () => null)).toBeNull();
    expect(authority.revokeTask.mock.calls).toEqual([['task-1']]);
    await expect(
      bindOxyTask(input, async () => {
        throw new Error('database blinked');
      }),
    ).rejects.toThrow('database blinked');
    expect(authority.revokeTask.mock.calls).toEqual([['task-1'], ['task-1']]);
  });

  it('tells Oxy refusing the task itself from refusing the operation asked of it', () => {
    const refusal = Object.assign(new Error('Task authority is no longer active.'), {
      status: 403,
    });
    expect(isTaskAuthorityRefusal(refusal)).toBe(true);
    const otherRefusal = Object.assign(
      new Error('The resource must belong to the authenticated requester account.'),
      { status: 403 },
    );
    expect(isTaskAuthorityRefusal(otherRefusal)).toBe(false);
    expect(isTaskAuthorityRefusal(Object.assign(new Error('down'), { status: 503 }))).toBe(false);
    expect(isTaskAuthorityRefusal(null)).toBe(false);
  });
});
