/**
 * The conversation an external agent's run names (ADR 0041) reaches its tools only when it is the
 * owner's own chat with that gemie: another person's, another gemie's, a conversation between
 * gemies, or one that does not exist is no conversation at all — never an error, never a widening.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  conversation: undefined as undefined | { agentId: string },
  betweenGemies: false,
  forUser: [] as Array<Record<string, unknown>>,
  owner: 'person-1',
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: async (_db: unknown, id: string) => ({ _id: id, ownerOxyAccountId: H.owner }),
}));
vi.mock('../../agent-identity.js', () => ({
  attachAgentIdentity: async (agent: unknown) => agent,
}));
vi.mock('../../../db/chat/conversationRepository.js', () => ({
  findConversation: async (_db: unknown, owner: string) =>
    owner === 'person-1' ? H.conversation : undefined,
}));
vi.mock('../../../db/chat/gemieConversationRepository.js', () => ({
  isGemieConversation: async () => H.betweenGemies,
}));
vi.mock('../../tool-pipeline.js', () => ({
  ToolPipeline: {
    forUser: async (options: Record<string, unknown>) => {
      H.forUser.push(options);
      return { tools: {} };
    },
  },
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

const { externalAgentTools } = await import('../tool-server.js');

const scope = { agentId: 'codea', ownerOxyUserId: 'person-1', conversationId: 'chat-1' };
const handed = () => H.forUser.at(-1)?.gemieChat;

beforeEach(() => {
  H.forUser.length = 0;
  H.conversation = { agentId: 'codea' };
  H.betweenGemies = false;
});

describe('the conversation a run names', () => {
  it('reaches the tools when it is the owner’s chat with this gemie', async () => {
    await externalAgentTools(scope);
    expect(handed()).toBe('chat-1');
  });

  it('is no conversation when it is another gemie’s chat, theirs to read, or missing', async () => {
    H.conversation = { agentId: 'someone-else' };
    await externalAgentTools(scope);
    expect(handed()).toBeUndefined();

    H.conversation = { agentId: 'codea' };
    H.betweenGemies = true;
    await externalAgentTools(scope);
    expect(handed()).toBeUndefined();

    H.conversation = undefined;
    await externalAgentTools(scope);
    expect(handed()).toBeUndefined();
  });

  it('is never another person’s: the owner is the link’s, not the run’s', async () => {
    await externalAgentTools({ ...scope, ownerOxyUserId: 'person-2' });
    expect(H.forUser).toEqual([]);
    H.owner = 'person-2';
    await externalAgentTools({ ...scope, ownerOxyUserId: 'person-2' });
    expect(handed()).toBeUndefined();
    H.owner = 'person-1';
  });

  it('is none when the run names none', async () => {
    await externalAgentTools({ agentId: 'codea', ownerOxyUserId: 'person-1' });
    expect(handed()).toBeUndefined();
  });
});
