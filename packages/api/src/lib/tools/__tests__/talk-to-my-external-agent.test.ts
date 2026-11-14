/**
 * "Puedes hablar con Claude?" — on Telegram, the person asks their gemie Eusebio to talk to Claude,
 * their own external agent (Claude Code connected through Codea, ADR 0030). Eusebio must know it can
 * (its `sendMessage` names the person's gemies and connected agents), find Claude by name among them
 * — not only in the public directory, where Claude is not — and write to it (ADR 0041).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'person-1';
const EUSEBIO = { _id: 'eusebio', identity: { source: 'oxy', oxyAccountId: 'bot-eusebio' } };
const CLAUDE = {
  _id: 'claude-desk',
  identity: { source: 'local', name: 'Claude', color: 'orange' },
};
const NOTES = { _id: 'notes', identity: { source: 'local', name: 'Claude Notes', color: 'teal' } };

const H = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  listActiveAgentsByAuthor: async (_db: unknown, owner: string) =>
    owner === OWNER
      ? [
          { ...EUSEBIO, tagline: 'Your assistant on Telegram' },
          { ...CLAUDE, tagline: 'Claude Code on the desk computer' },
        ]
      : [],
  findAgentById: async (_db: unknown, id: string) =>
    [EUSEBIO, CLAUDE, NOTES].find((agent) => agent._id === id) ?? null,
  // The public directory does not have Claude: it is the person's, not published.
  searchActiveAgents: async () => [],
}));
vi.mock('../../agent-identity.js', () => {
  const named = (agent: { _id: string; identity: { source: string; name?: string } }) => ({
    ...agent,
    name: agent.identity.source === 'local' ? agent.identity.name : 'Eusebio',
    handle: agent.identity.source === 'local' ? null : 'eusebiobot',
    color: null,
    character: null,
  });
  return {
    attachAgentIdentity: async (agent: Parameters<typeof named>[0]) => named(agent),
    attachAgentIdentities: async (agents: Parameters<typeof named>[0][]) => agents.map(named),
    agentPromptName: (agent: { name?: string | null; handle?: string | null }) =>
      agent.name ?? agent.handle ?? 'Agent',
  };
});
vi.mock('../../agent-account.js', () => ({ canReachAgent: async () => 'reachable' }));
vi.mock('../../agent-availability.js', () => ({ agentOpensOn: async () => 'reachable' }));
vi.mock('../../chat/gemies/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../chat/gemies/send.js')>()),
  sendGemieMessage: async (input: Record<string, unknown>) => {
    H.sent.push(input);
    return { conversationId: 'eusebio-claude', messageId: 'gemie-message-k-0', chainId: 'k' };
  },
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

const { createSearchAgentsTool } = await import('../agent-search.js');
const { buildSendMessageTool } = await import('../send-message.js');

/** Eusebio's turn on its Telegram bot, the person present (`gemieChat`). */
const eusebiosTool = () =>
  buildSendMessageTool({
    person: { oxyUserId: OWNER, isDirectSession: false, surfaceApplicationId: null },
    from: {
      ...EUSEBIO,
      name: 'Eusebio',
      handle: 'eusebiobot',
      color: null,
      character: null,
    } as never,
    delivery: { startsIn: 'telegram:8988966019:570038640' },
  });
const call = { toolCallId: 't', messages: [] };

beforeEach(() => {
  H.sent.length = 0;
});

describe('Eusebio, asked to talk to Claude', () => {
  it('knows it can: its tool names the person’s connected agent, by name', async () => {
    const { sendMessage } = await eusebiosTool();
    expect(sendMessage.description).toContain('agents they connected');
    expect(sendMessage.description).toContain(
      "claude-desk — Claude [an agent on the person's computer]",
    );
    // Never itself.
    expect(sendMessage.description).not.toContain('- eusebio —');
  });

  it('finds Claude by name among the person’s own, though the directory has no Claude', async () => {
    const search = createSearchAgentsTool(OWNER, null);
    const found = (await search.execute?.({ query: 'claude' }, call)) as {
      agents: Array<{ id: string; theirs?: boolean; external?: boolean }>;
    };
    expect(found.agents).toEqual([
      expect.objectContaining({ id: 'claude-desk', name: 'Claude', theirs: true, external: true }),
    ]);
  });

  it('writes to Claude by the name the person used, from the Telegram chat', async () => {
    const { sendMessage } = await eusebiosTool();
    const result = (await sendMessage.execute?.(
      { to: 'claude', text: 'Hola Claude, ¿puedes revisar el despliegue de hoy?' },
      call,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: 'sent',
      conversationId: 'eusebio-claude',
      to: { id: 'claude-desk', name: 'Claude' },
    });
    expect(H.sent[0]).toMatchObject({
      userId: OWNER,
      originConversationId: 'telegram:8988966019:570038640',
      to: { info: { id: 'claude-desk' } },
    });
  });

  it('asks which one rather than guessing when a name fits several', async () => {
    const { listOwnGemies, gemiesNamed } = await import('../own-gemies.js');
    const gemies = [
      ...(await listOwnGemies(OWNER)),
      { id: 'notes', name: 'Claude Notes', handle: null, tagline: '', external: true },
    ];
    expect(gemiesNamed(gemies, 'Claude').map((gemie) => gemie.id)).toEqual(['claude-desk']);
    expect(gemiesNamed(gemies, 'clau').map((gemie) => gemie.id)).toEqual(['claude-desk', 'notes']);
    expect(gemiesNamed(gemies, '@eusebiobot').map((gemie) => gemie.id)).toEqual(['eusebio']);
  });
});
