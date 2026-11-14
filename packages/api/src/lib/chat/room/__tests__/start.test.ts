import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  reach: vi.fn(),
  hydrate: vi.fn(),
  save: vi.fn(),
  latest: vi.fn(),
  list: vi.fn(),
  space: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../../activity.js', () => ({
  markConversationActive: vi.fn(async () => undefined),
  clearConversationActive: vi.fn(async () => undefined),
}));
vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../../db/agents/agentRepository.js', () => ({ findAgentById: h.find }));
vi.mock('../../../../db/chat/messageRepository.js', () => ({
  findLatestUserMessage: h.latest,
  listMessages: h.list,
}));
vi.mock('../../../../db/spaces/spaceRepository.js', () => ({ findSpaceByConversation: h.space }));
vi.mock('../../../agent-account.js', () => ({ canReachAgent: h.reach }));
vi.mock('../../../agent-identity.js', () => ({
  attachAgentIdentity: h.hydrate,
  agentPromptName: (a: { name: string }) => a.name,
}));
vi.mock('../../../conversation-saver.js', () => ({ saveConversation: h.save }));
vi.mock('../queue.js', () => ({ enqueueRoomJob: h.enqueue }));
vi.mock('../../../logger.js', () => ({
  log: { general: { error: vi.fn() }, agents: { warn: vi.fn() } },
}));
const { prepareRoom } = await import('../start.js');
const input = {
  userId: 'u',
  conversationId: 'room',
  memberAgentIds: ['s', 'e'],
  messages: [{ id: 'client-p', role: 'user', content: 'Eusebio, ¿qué puedes hacer?' }],
  accessToken: 'PRIVATE_BEARER',
  surfaceApplicationId: 'alia',
  personalization: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.find.mockImplementation(async (_db, id) => ({
    _id: id,
    identity: { source: 'oxy', oxyAccountId: `bot-${id}` },
    description: `${id} public remit`,
  }));
  h.reach.mockResolvedValue('reachable');
  h.hydrate.mockImplementation(async (agent) => ({
    ...agent,
    name: agent._id === 's' ? 'Salella' : 'Eusebio',
    handle: agent._id,
    color: null,
    character: null,
  }));
  h.latest.mockResolvedValue({ id: 'row-p', clientMessageId: 'client-p' });
  h.list.mockResolvedValue([
    { id: 'row-p', clientMessageId: 'client-p', content: input.messages[0]!.content },
  ]);
  h.space.mockResolvedValue(null);
});

describe('room preparation', () => {
  it('cannot enqueue work when durable activity admission fails', async () => {
    const { markConversationActive } = await import('../../activity.js');
    vi.mocked(markConversationActive).mockRejectedValueOnce(new Error('admission unavailable'));
    const room = await prepareRoom(input);
    await expect(room.start()).rejects.toThrow('admission unavailable');
    expect(h.enqueue).not.toHaveBeenCalled();
    await room.abandon();
  });
  it('queues selection, not a roster-wide round, with no bearer or task in its data', async () => {
    const room = await prepareRoom(input);
    expect(room.ready).toBe(true);
    await room.start();
    expect(h.enqueue).toHaveBeenCalledOnce();
    const job = h.enqueue.mock.calls[0]?.[0];
    expect(job).toMatchObject({
      version: 2,
      phase: 'select',
      triggerId: 'row-p',
      speakerId: '',
      pending: [],
    });
    expect(JSON.stringify(job)).not.toContain('PRIVATE_BEARER');
    expect(job.roster[1]).toMatchObject({ description: 'e public remit', available: true });
    // Each member acts for the person on Gemies' own first-party authority (oxy ADR 0066).
    expect(Object.keys(job.roster[1]).sort()).toEqual(['available', 'description', 'info']);
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.enqueue.mock.invocationCallOrder[0]!);
  });

  it('keeps the person’s personalization off on the chain it starts, and says nothing when on', async () => {
    await (await prepareRoom(input)).start();
    expect(h.enqueue.mock.calls[0]?.[0]).not.toHaveProperty('personalization');

    await (await prepareRoom({ ...input, personalization: false })).start();
    expect(h.enqueue.mock.calls[1]?.[0]).toMatchObject({ personalization: false });
  });

  it('keeps unavailable Eusebio identifiable, without its private description', async () => {
    h.reach.mockImplementation(async (agent) => (agent._id === 'e' ? 'unreachable' : 'reachable'));
    const room = await prepareRoom(input);
    await room.start();
    const e = h.enqueue.mock.calls[0]?.[0].roster[1];
    expect(e).toMatchObject({ info: { id: 'e', name: 'Eusebio' }, available: false });
    expect(e.description).toBeUndefined();
  });

  it('does not lose a known unavailable identity when authority lookup fails', async () => {
    h.reach.mockRejectedValue(new Error('Oxy down'));
    const room = await prepareRoom(input);
    expect(room.ready).toBe(false);
    await room.start();
    expect(h.enqueue.mock.calls[0]?.[0].roster[1]).toMatchObject({
      info: { name: 'Eusebio' },
      available: false,
    });
  });

  it('starts nothing when space preparation fails', async () => {
    h.space.mockRejectedValue(new Error('database down'));
    await expect(prepareRoom(input)).rejects.toThrow('database down');
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('binds its own stored trigger even when a newer request wins the latest-message race', async () => {
    h.latest.mockResolvedValue({ id: 'row-newer', clientMessageId: 'newer' });
    h.list.mockResolvedValue([
      { id: 'row-p', clientMessageId: 'client-p', content: input.messages[0]!.content },
    ]);
    const room = await prepareRoom(input);
    expect(room.chainId).toBe('row-p');
    await room.start();
    expect(h.enqueue.mock.calls[0]?.[0].triggerId).toBe('row-p');
  });
});
