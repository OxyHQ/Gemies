import { beforeEach, describe, expect, it, vi } from 'vitest';
import { personaGemie } from '../../../../__tests__/support/gemies.js';
const h = vi.hoisted(() => ({
  db: vi.fn(() => ({})),
  find: vi.fn(),
  targets: vi.fn(),
  mutate: vi.fn(),
  complete: vi.fn(),
  opens: vi.fn(),
  publish: vi.fn(),
}));
vi.mock('../../../../db/index.js', () => ({ getDb: h.db }));
vi.mock('../../../../db/agents/agentRepository.js', () => ({ findAgentById: h.find }));
vi.mock('../../../../db/chat/reactionRepository.js', () => ({
  listAgentReactionTargets: h.targets,
  mutateAgentMessageReaction: h.mutate,
  markAgentReactionTurnComplete: h.complete,
}));
vi.mock('../../../agent-availability.js', () => ({ agentOpensOn: h.opens }));
vi.mock('../../../agent-identity.js', () => ({
  agentPromptName: (agent: { name: string }) => agent.name,
}));
vi.mock('../bus.js', () => ({ publishConversationReaction: h.publish }));
const { prepareAgentReactionTurn } = await import('../agent-runtime.js');
const actor = () => personaGemie({ _id: 'a', id: 'a', name: 'Salina' });
const local = () =>
  personaGemie({
    _id: 'a',
    id: 'a',
    name: 'Local',
    identity: { source: 'local', name: 'Local', color: '#123456' },
    mailbox: false,
  });
const input = () => ({
  userId: 'person',
  conversationId: 'thread',
  agent: actor(),
  turnId: 'turn',
  expectedLatestUserMessage: { id: 'person-message', content: 'Gracias' },
  surfaceApplicationId: 'surface',
  allowedActorIds: ['a'],
});
beforeEach(() => {
  vi.clearAllMocks();
  h.find.mockResolvedValue(actor());
  h.opens.mockResolvedValue('reachable');
  h.targets.mockResolvedValue([
    { id: 'peer', role: 'assistant', content: 'Listo', agentInfoId: 'historical-peer' },
  ]);
  h.mutate.mockImplementation(async (_db, _owner, _thread, messageId, value) => ({
    messageId,
    reactions: [],
    reactionEntries: [{ emoji: value.emoji, author: { kind: 'agent', ...value.actor } }],
    revision: 1,
    mutationId: value.mutationId,
  }));
  h.complete.mockResolvedValue(true);
  h.publish.mockResolvedValue(undefined);
});
async function hostedTurn() {
  const turn = await prepareAgentReactionTurn(input());
  if (!turn) throw new Error('Hosted capability was not prepared');
  return turn;
}
const execute = (turn: NonNullable<Awaited<ReturnType<typeof prepareAgentReactionTurn>>>) => {
  if (!turn.tool.execute) throw new Error('Native tool execute is absent');
  return turn.tool.execute(
    { messageId: 'peer', emoji: '❤️', active: true, finishTurn: true },
    { toolCallId: 'operation', messages: [] },
  );
};
describe('hosted reaction identity', () => {
  it('does not build a hosted capability for a local identity or query Oxy for it', async () => {
    expect(await prepareAgentReactionTurn({ ...input(), agent: local() })).toBeUndefined();
    expect(h.db).not.toHaveBeenCalled();
    expect(h.opens).not.toHaveBeenCalled();
  });
  it('uses the current stored hosted identity and retains historical peer targets', async () => {
    const turn = await hostedTurn();
    const result = await execute(turn);
    expect(result).toMatchObject({ success: true, actorId: 'a', messageId: 'peer' });
    expect(h.opens).toHaveBeenCalledWith(actor(), 'surface');
    expect(h.mutate).toHaveBeenCalledWith(
      {},
      'person',
      'thread',
      'peer',
      expect.objectContaining({
        actor: { id: 'a', name: 'Salina' },
        expectedTarget: { content: 'Listo', role: 'assistant', actorId: 'historical-peer' },
      }),
    );
    expect(
      await turn.complete('', [{ toolName: 'react_to_message', state: 'result', result }]),
    ).toBe(true);
    expect(h.complete).toHaveBeenCalledOnce();
  });
  it('refuses a sender changed to local after admission without inventing an Oxy account', async () => {
    const turn = await hostedTurn();
    h.find.mockResolvedValue(local());
    expect(await execute(turn)).toMatchObject({ success: false });
    expect(h.opens).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it('refuses completion if a previously successful sender became local', async () => {
    const turn = await hostedTurn();
    const result = await execute(turn);
    h.find.mockResolvedValue(local());
    await expect(
      turn.complete('', [{ toolName: 'react_to_message', state: 'result', result }]),
    ).rejects.toThrow('Reaction turn completion unavailable');
    expect(h.complete).not.toHaveBeenCalled();
  });
  it('keeps surface confinement on hosted identities', async () => {
    const turn = await hostedTurn();
    h.opens.mockResolvedValue('out_of_reach');
    expect(await execute(turn)).toMatchObject({ success: false });
    expect(h.mutate).not.toHaveBeenCalled();
  });
});
