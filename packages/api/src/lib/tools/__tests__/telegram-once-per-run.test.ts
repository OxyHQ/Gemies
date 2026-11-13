import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A Redis with the one behaviour the claim relies on: SET ... NX is atomic and DEL removes. */
const marks = vi.hoisted(() => new Map<string, string>());
const redis = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
    if (marks.has(key)) return null;
    marks.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => (marks.delete(key) ? 1 : 0)),
}));
const redisState = vi.hoisted(() => ({ available: true }));
const accounts = vi.hoisted(() => ({
  list: [] as Array<{ id: string; platform: string; sessionId: string | null; status: string }>,
}));
const notify = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<{ messageId: string }> => ({ messageId: 'm1' })),
);

vi.mock('../../redis.js', () => ({ getRedisClient: () => (redisState.available ? redis : null) }));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/integrations/connectedAccountRepository.js', () => ({
  listGemieAccounts: vi.fn(async () => accounts.list),
}));
vi.mock('../../gemie-accounts.js', () => ({ notifyAccountPerson: notify }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { tools: child } };
});

const { buildSendTelegramTool } = await import('../telegram.js');

const SCOPE = { agentId: 'gemie-1', oxyUserId: 'u1' };
const LINKED = { id: 'acc-1', platform: 'telegram', sessionId: 's-1', status: 'connected' };

type Exec = (input: { message: string }, options: never) => Promise<{ success: boolean }>;
async function send(runId: string | undefined, message: string) {
  const tools: ToolSet = await buildSendTelegramTool(SCOPE, runId);
  const tool = tools.sendTelegramMessage;
  if (!tool) throw new Error('sendTelegramMessage was not offered');
  return (tool.execute as unknown as Exec)({ message }, {} as never);
}

beforeEach(() => {
  marks.clear();
  vi.clearAllMocks();
  redisState.available = true;
  accounts.list = [LINKED];
  process.env.INTEGRATIONS_URL = 'http://integrations.test';
});

describe('sendTelegramMessage', () => {
  it('is offered only when the person linked their Telegram to this gemie', async () => {
    accounts.list = [{ ...LINKED, platform: 'whatsapp' }];
    expect(await buildSendTelegramTool(SCOPE)).toEqual({});
    accounts.list = [{ ...LINKED, status: 'logged-out' }];
    expect(await buildSendTelegramTool(SCOPE)).toEqual({});
    accounts.list = [{ ...LINKED, status: 'paused' }];
    expect(Object.keys(await buildSendTelegramTool(SCOPE))).toEqual(['sendTelegramMessage']);
  });

  it('writes to the person through their linked account', async () => {
    expect((await send(undefined, 'hola')).success).toBe(true);
    expect(notify).toHaveBeenCalledWith(LINKED, 'u1', 'hola');
  });
});

describe('sendTelegramMessage inside a run', () => {
  it('sends a message once however many times the run is retried', async () => {
    const first = await send('run-1', 'Tu tarea terminó');
    // The queue retries the whole run: a new tool, the same run.
    const retry = await send('run-1', 'Tu tarea terminó');

    expect(first.success).toBe(true);
    expect(retry.success).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('still sends a different message, and the same message in a different run', async () => {
    await send('run-1', 'uno');
    await send('run-1', 'dos');
    await send('run-2', 'uno');
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('lets the retry send what failed the first time: a failed send releases its claim', async () => {
    notify.mockImplementationOnce(async () => {
      throw new Error('Bad Gateway');
    });
    const failed = await send('run-1', 'aviso');
    expect(failed.success).toBe(false);

    const retried = await send('run-1', 'aviso');
    expect(retried.success).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('is not limited outside a run: a chat can send the same text twice', async () => {
    await send(undefined, 'hola');
    await send(undefined, 'hola');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('sends when there is no Redis to claim against, and when Redis errors', async () => {
    redisState.available = false;
    await send('run-1', 'sin redis');
    redisState.available = true;
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    await send('run-1', 'redis caído');
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
