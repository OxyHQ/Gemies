import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  findAgent: vi.fn(),
  findConversation: vi.fn(),
  createConversation: vi.fn(),
  upsertConversation: vi.fn(),
  countOutreach: vi.fn(),
  latestMarks: vi.fn(),
  findLast: vi.fn(),
  insert: vi.fn(),
  notify: vi.fn(),
  publish: vi.fn(),
  receipt: vi.fn(),
  relay: vi.fn(),
}));

vi.mock('../../../db/index.js', () => {
  const tx = {
    execute: async () => {},
    transaction: async (work: (db: unknown) => unknown): Promise<unknown> => work(tx),
  };
  return { getDb: () => tx };
});
vi.mock('../../../db/agents/agentRepository.js', () => ({ findAgentById: H.findAgent }));
vi.mock('../../../db/chat/conversationRepository.js', () => ({
  findActiveThreadConversation: H.findConversation,
  createConversation: H.createConversation,
  upsertConversation: H.upsertConversation,
}));
vi.mock('../../../db/chat/messageRepository.js', () => ({
  countAgentOutreachSince: H.countOutreach,
  listLatestMessageMarks: H.latestMarks,
  findLastMessage: H.findLast,
  insertMessages: H.insert,
  findMessageReceipt: H.receipt,
}));
vi.mock('../../agent-identity.js', () => ({
  attachAgentIdentity: async (agent: object) => ({
    ...agent,
    name: 'Scout',
    handle: 'scout',
    color: 'blue',
  }),
  agentPromptName: (agent: { name: string }) => agent.name,
}));
vi.mock('../../notification-service.js', () => ({ sendNotification: H.notify }));
vi.mock('../../gemie-telegram-bot-setup.js', () => ({ relayToGemieBotChat: H.relay }));
vi.mock('../../realtime/conversations.js', () => ({ publishConversation: H.publish }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

import { CHECK_IN_DAILY_LIMIT, postAgentMessage, runResultMessage } from '../agent-outreach.js';

beforeEach(() => {
  vi.clearAllMocks();
  H.receipt.mockResolvedValue(null);
  H.findAgent.mockResolvedValue({ _id: 'agent-1', oxyAccountId: 'bot-1' });
  H.findConversation.mockResolvedValue({ conversationId: 'conv-1' });
  H.countOutreach.mockResolvedValue(0);
  H.latestMarks.mockResolvedValue([{ role: 'user', clientMessageId: 'msg-3' }]);
  H.findLast.mockResolvedValue({ seq: 3 });
  H.insert.mockResolvedValue(undefined);
  H.notify.mockResolvedValue(undefined);
  H.upsertConversation.mockResolvedValue(undefined);
  H.relay.mockResolvedValue(undefined);
});

describe('an agent writing to a person first', () => {
  it('appends to the END of its conversation, marked, and tells the person', async () => {
    const outcome = await postAgentMessage({
      oxyUserId: 'u',
      agentId: 'agent-1',
      kind: 'check_in',
      content: 'Found it',
    });

    expect(outcome).toMatchObject({ posted: true, conversationId: 'conv-1' });
    const [[, [row]]] = H.insert.mock.calls as [[unknown, Array<Record<string, unknown>>]];
    expect(row).toMatchObject({ role: 'assistant', content: 'Found it', seq: 4 });
    expect(String(row.clientMessageId)).toMatch(/^agent-push-/);
    // Every surface of the person hears it, with the message it gained.
    expect(H.publish).toHaveBeenCalledWith('u', 'conv-1', { appendedFromSeq: 4 });
    expect(H.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u', conversationId: 'conv-1', type: 'proactive_insight' }),
    );
  });

  it('stops check-ins at the daily budget', async () => {
    H.countOutreach.mockResolvedValue(CHECK_IN_DAILY_LIMIT);

    await expect(
      postAgentMessage({ oxyUserId: 'u', agentId: 'agent-1', kind: 'check_in', content: 'Again' }),
    ).resolves.toEqual({ posted: false, reason: 'daily_limit' });
    expect(H.insert).not.toHaveBeenCalled();
  });

  it('stops check-ins when its last messages went unanswered', async () => {
    H.latestMarks.mockResolvedValue([
      { role: 'assistant', clientMessageId: 'agent-push-b' },
      { role: 'assistant', clientMessageId: 'agent-push-a' },
    ]);

    await expect(
      postAgentMessage({ oxyUserId: 'u', agentId: 'agent-1', kind: 'check_in', content: 'Hello?' }),
    ).resolves.toEqual({ posted: false, reason: 'unanswered' });
  });

  it('always delivers a result the person asked for, whatever the budget', async () => {
    H.countOutreach.mockResolvedValue(99);
    H.latestMarks.mockResolvedValue([
      { role: 'assistant', clientMessageId: 'agent-push-b' },
      { role: 'assistant', clientMessageId: 'agent-push-a' },
    ]);

    await expect(
      postAgentMessage({
        oxyUserId: 'u',
        agentId: 'agent-1',
        kind: 'result',
        content: 'Your report',
      }),
    ).resolves.toMatchObject({ posted: true });
    expect(H.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_task_complete' }));
  });

  it('opens a conversation when the person has none with the agent yet', async () => {
    H.findConversation.mockResolvedValue(undefined);
    H.createConversation.mockResolvedValue({ conversationId: 'new-conv' });
    H.findLast.mockResolvedValue(undefined);

    const outcome = await postAgentMessage({
      oxyUserId: 'u',
      agentId: 'agent-1',
      kind: 'result',
      content: 'Hi',
    });

    expect(outcome).toMatchObject({ posted: true, conversationId: 'new-conv' });
    expect(H.createConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: 'agent-1', oxyUserId: 'u' }),
    );
    const [[, [row]]] = H.insert.mock.calls as [[unknown, Array<Record<string, unknown>>]];
    expect(row).toMatchObject({ seq: 0 });
  });
});

it('replays a stored delivery without another insert or notification', async () => {
  H.receipt.mockResolvedValue({ conversationId: 'conv-1' });
  expect(
    await postAgentMessage({
      oxyUserId: 'u',
      agentId: 'agent-1',
      kind: 'check_in',
      content: 'Done',
      idempotencyKey: 'run:1',
    }),
  ).toMatchObject({ posted: true });
  expect(H.insert).not.toHaveBeenCalled();
  expect(H.notify).not.toHaveBeenCalled();
});

/**
 * A requested run that ended without an answer reaches the person as a typed failure, which the
 * app draws in their language: never the run's status line ("Token budget exhausted. Partial
 * progress was made.", delivered as Eusebio's message on 2026-11-14), on Telegram neither.
 */
describe('a requested run’s result', () => {
  const asked = 'Saluda al usuario con un resumen de su email.';

  it('is its answer when it has one', () => {
    expect(runResultMessage({ status: 'completed', result: ' Hola ', task: asked })).toEqual({
      content: 'Hola',
    });
  });

  it('is the typed failure when it has none, whatever its status line says', () => {
    for (const run of [
      { status: 'failed' as const, result: 'Stopped at the token budget without an answer' },
      { status: 'completed' as const, result: '' },
    ]) {
      expect(runResultMessage({ ...run, task: asked })).toEqual({
        content: asked,
        failure: 'task_unfinished',
      });
    }
  });

  it('stores the failure as its part, relays no words and names what was asked', async () => {
    await postAgentMessage({
      oxyUserId: 'u',
      agentId: 'agent-1',
      kind: 'result',
      ...runResultMessage({ status: 'failed', result: 'Token budget exhausted.', task: asked }),
    });

    const [[, [row]]] = H.insert.mock.calls as [[unknown, Array<Record<string, unknown>>]];
    expect(row?.content).toEqual([{ type: 'failure', code: 'task_unfinished' }]);
    expect(H.relay).not.toHaveBeenCalled();
    expect(H.notify).toHaveBeenCalledWith(expect.objectContaining({ body: asked }));
    expect(JSON.stringify([H.insert.mock.calls, H.notify.mock.calls])).not.toContain(
      'Token budget',
    );
  });
});
