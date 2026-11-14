import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  create: vi.fn(),
  find: vi.fn(),
  cancel: vi.fn(),
  findAgent: vi.fn(),
  run: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentSessionRepository.js', () => ({
  createAgentSession: H.create,
  findAgentSessionById: H.find,
  cancelUnsettledAgentSession: H.cancel,
}));
vi.mock('../../agent-identity.js', () => ({ findAgentByOxyHandle: H.findAgent }));
vi.mock('../runner.js', () => ({ runAgentSession: H.run }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

import { executeSubtasks, type ExecutorPoolOptions } from '../executor-pool.js';

const parentSession: ExecutorPoolOptions['parentSession'] = {
  _id: 'parent-1',
  userId: 'person-1',
  agentId: 'agent-1',
  depth: 0,
  config: { maxSteps: 30, maxTokens: 100_000, maxVMs: 3 },
};

const options = (parent: ExecutorPoolOptions['parentSession']): ExecutorPoolOptions => ({
  maxConcurrency: 2,
  maxStepsPerExecutor: 10,
  maxTokensPerExecutor: 20_000,
  timeoutMs: 60_000,
  parentSession: parent,
});

const subtasks = [
  { id: 1, description: 'Find the invoice', dependsOn: [], complexity: 'light' as const },
  { id: 2, description: 'Reply to it', dependsOn: [1], complexity: 'medium' as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  H.create.mockImplementation(async () => ({ _id: `executor-${++n}` }));
  H.run.mockResolvedValue(undefined);
  H.find.mockResolvedValue({ status: 'completed', result: 'done', stats: { totalTokens: 7 } });
});

describe('an orchestrated session’s executors', () => {
  it('run under the parent’s Oxy task, as a delegated child does, so they keep its oxy_* tools', async () => {
    const results = await executeSubtasks(
      subtasks,
      options({ ...parentSession, oxyTaskId: 'oxy-task-1' }),
    );

    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect(H.create).toHaveBeenCalledTimes(2);
    for (const [, session] of H.create.mock.calls as [[unknown, Record<string, unknown>]]) {
      expect(session).toMatchObject({
        oxyUserId: 'person-1',
        parentSessionId: 'parent-1',
        oxyTaskId: 'oxy-task-1',
        depth: 1,
      });
    }
  });

  it('carry no task when the parent runs without one', async () => {
    await executeSubtasks(subtasks.slice(0, 1), options({ ...parentSession, oxyTaskId: null }));

    const [[, session]] = H.create.mock.calls as [[unknown, Record<string, unknown>]];
    expect(session).not.toHaveProperty('oxyTaskId');
  });
});
