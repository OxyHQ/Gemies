/**
 * `sendMessage` (ADR 0041): a gemie writes to another, and the tool returns at once.
 *
 *  - reach is the person's (`canReachAgent`), narrowed by the writer's selection, never itself;
 *  - the recipient's feature gates are checked, then spent, against what the turn carries, on the
 *    person's own lane, before anything is sent (ADR 0020 §6); a refusal sends nothing;
 *  - from the person's chat it starts a chain there; continuing a chain it hands the text to the
 *    chain's delivery and to nobody else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  sequence: [] as string[],
  check: null as Record<string, unknown> | null,
  people: [] as unknown[],
  reach: 'reachable' as string,
  sent: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../agent-features.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-features.js')>();
  return {
    ...actual,
    checkGatedParts: async (_agent: unknown, person: unknown) => {
      H.sequence.push('check');
      H.people.push(person);
      return H.check;
    },
    spendGatedParts: async () => {
      H.sequence.push('spend');
      return null;
    },
  };
});
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: async (_db: unknown, id: string) =>
    id === 'missing' ? null : { ...SINDI, _id: id },
  listActiveAgentsByAuthor: async () => [],
}));
vi.mock('../../agent-account.js', () => ({ canReachAgent: async () => H.reach }));
vi.mock('../../agent-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-identity.js')>()),
  attachAgentIdentity: async (agent: Record<string, unknown>) => ({
    ...agent,
    handle: 'sindi',
    color: null,
    character: null,
  }),
  attachAgentIdentities: async (agents: unknown[]) => agents,
}));
vi.mock('../../chat/gemies/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../chat/gemies/send.js')>()),
  sendGemieMessage: async (input: Record<string, unknown>) => {
    H.sequence.push('send');
    H.sent.push(input);
    return { conversationId: 'between', messageId: 'gemie-message-c-0', chainId: 'c' };
  },
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

const { buildSendMessageTool } = await import('../send-message.js');

const SINDI = {
  _id: 'sindi',
  name: 'Sindi',
  featureGates: { 'attachments.documents': { app: 'homiio', feature: 'files' } },
};
const WRITER = { _id: 'writer', name: 'Pepe', handle: 'pepe', color: null, character: null };
const person = {
  oxyUserId: 'person-1',
  accessToken: 'PERSON-TOKEN',
  isDirectSession: true,
  surfaceApplicationId: null,
};
const lease = { feature: 'attachments.documents' as const, operationKey: 'LEASE' };
const photo = { feature: 'attachments.images' as const, operationKey: 'PHOTO' };

beforeEach(() => {
  H.sequence.length = 0;
  H.people.length = 0;
  H.sent.length = 0;
  H.check = null;
  H.reach = 'reachable';
});

async function write(
  to: string,
  over: Partial<Parameters<typeof buildSendMessageTool>[0]> = {},
): Promise<Record<string, unknown>> {
  const tools = await buildSendMessageTool({
    person,
    from: WRITER as never,
    delivery: { startsIn: 'chat-1' },
    ...over,
  });
  return (await tools.sendMessage.execute?.(
    { to, text: 'Is this lease fair?' },
    { toolCallId: 't', messages: [] },
  )) as Record<string, unknown>;
}

describe('who a gemie may write to', () => {
  it('starts a chain in the person’s chat and returns at once', async () => {
    const result = await write('sindi');
    expect(result).toMatchObject({
      status: 'sent',
      conversationId: 'between',
      chainId: 'c',
      from: { id: 'writer', name: 'Pepe' },
      to: { id: 'sindi', name: 'Sindi' },
    });
    expect(H.sent[0]).toMatchObject({
      userId: 'person-1',
      originConversationId: 'chat-1',
      text: 'Is this lease fair?',
      accessToken: 'PERSON-TOKEN',
    });
  });

  it('never writes to itself, nor outside its selection, nor to what the person cannot reach', async () => {
    expect(await write('writer')).toEqual({ error: 'That is not a gemie you can write to' });
    expect(await write('sindi', { allowedAgentIds: ['peer-1'] })).toEqual({
      error: 'That is not a gemie you can write to',
    });
    H.reach = 'unreachable';
    expect(await write('sindi')).toEqual({ error: 'Gemie not found' });
    expect(await write('missing')).toEqual({ error: 'Gemie not found' });
    expect(H.sent).toEqual([]);
  });

  it('is not built at all for an empty selection', async () => {
    expect(
      await buildSendMessageTool({
        person,
        from: WRITER as never,
        delivery: { startsIn: 'chat-1' },
        allowedAgentIds: [],
      }),
    ).toEqual({});
  });
});

describe("the recipient's gates over what the turn carries", () => {
  it('checks then spends what the recipient gates, on the person’s lane, before sending', async () => {
    await write('sindi', { attachments: [lease, photo] });
    expect(H.sequence).toEqual(['check', 'spend', 'send']);
    expect(H.people[0]).toMatchObject({ accountId: 'person-1', accessToken: 'PERSON-TOKEN' });
  });

  it('refuses a locked attachment in words the writer acts on, and sends nothing', async () => {
    H.check = {
      code: 'feature_entitlement_required',
      feature: 'attachments.documents',
      retryable: false,
    };
    const result = await write('sindi', { attachments: [lease] });
    expect(H.sequence).toEqual(['check']);
    expect(result.error).toContain('upgrade');
  });

  it('asks nothing when the recipient gates none of what the turn carries', async () => {
    await write('sindi', { attachments: [photo] });
    expect(H.sequence).toEqual(['send']);
  });
});

describe('continuing a chain', () => {
  it('hands the text to the chain, and starts nothing', async () => {
    const continues = vi.fn(async () => ({ conversationId: 'between', chainId: 'c' }));
    const result = await write('sindi', {
      delivery: { continues },
      allowedAgentIds: ['sindi'],
    });
    expect(continues).toHaveBeenCalledWith('Is this lease fair?');
    expect(result).toMatchObject({ status: 'sent', conversationId: 'between' });
    expect(H.sent).toEqual([]);
  });

  it('passes on the chain’s refusal', async () => {
    const continues = vi.fn(async () => ({ error: 'You already wrote this turn.' }));
    expect(await write('sindi', { delivery: { continues }, allowedAgentIds: ['sindi'] })).toEqual({
      error: 'You already wrote this turn.',
    });
  });
});
