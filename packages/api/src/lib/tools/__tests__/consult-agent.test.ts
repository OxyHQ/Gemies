/**
 * `consultAgent` (ADR 0020 §5): reach is the ordinary rule, the consulted agent
 * joins the conversation live (`alia.agent_*`), and its turn is the SAME
 * person's turn with the callee as the agent, paid by the outer payer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../../domain/conversation.js';

const H = vi.hoisted(() => ({
  agents: new Map<string, Record<string, unknown>>(),
  reach: 'reachable' as 'reachable' | 'out_of_reach' | 'identity_unavailable',
  turn: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: vi.fn(async (_db: unknown, id: string) => H.agents.get(id) ?? null),
  listActiveAgentsByAuthor: vi.fn(async () => []),
}));
vi.mock('../../agent-account.js', () => ({ canReachAgent: vi.fn(async () => H.reach) }));
vi.mock('../../agent-identity.js', () => ({
  agentPromptName: (agent: { name?: string }) => agent.name ?? 'Agent',
  attachAgentIdentity: async (agent: Record<string, unknown>) => ({
    ...agent,
    name: 'Sindi',
    handle: 'sindibot',
    color: 'teal',
    character: null,
  }),
  resolveAgentIdentities: async () => new Map(),
  UNRESOLVED_IDENTITY: {},
}));
vi.mock('../agent-turn.js', () => ({ runAgentTurn: H.turn }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

const { buildConsultAgentTool } = await import('../consult-agent.js');
const { getToolResultBudget, wrapToolsWithTruncation } = await import('../result-truncation.js');
const { sharedMessagesOf } = await import('../../shared-conversation.js');

interface Executable {
  execute: (input: { agentId: string; task: string }) => Promise<Record<string, unknown>>;
}

const person = {
  oxyUserId: 'person-1',
  accessToken: 'PERSON-TOKEN',
  isDirectSession: true,
  surfaceApplicationId: null,
};

async function consult(
  overrides: Partial<Parameters<typeof buildConsultAgentTool>[0]> = {},
  input = { agentId: 'sindi', task: 'Find a flat in Gràcia under 1200' },
) {
  const events: Array<[string, Record<string, unknown>]> = [];
  const tools = await buildConsultAgentTool({
    person,
    payerOxyUserId: 'person-1',
    callerAgentId: null,
    sseEmitter: { emit: (event, data) => events.push([event, data]) },
    ...overrides,
  });
  const tool = tools.consultAgent as unknown as Executable | undefined;
  return { tools, events, result: tool ? await tool.execute(input) : undefined };
}

beforeEach(() => {
  H.agents = new Map([['sindi', { _id: 'sindi', oxyAccountId: 'sindi-bot', status: 'active' }]]);
  H.reach = 'reachable';
  H.turn.mockReset();
  H.turn.mockImplementation(async ({ observer }) => {
    observer.onTextDelta('Hay ');
    observer.onToolCall({ toolCallId: 't1', name: 'oxy_homiio__searchListings', input: {} });
    observer.onToolResult({ toolCallId: 't1', name: 'oxy_homiio__searchListings', output: [] });
    observer.onTextDelta('tres pisos.');
    return { response: 'Hay tres pisos.', tokensUsed: 42, creditsCharged: 1 };
  });
});

describe('consultAgent', () => {
  it("runs the callee as the same person's turn, paid by the outer payer, and streams it", async () => {
    const { events, result } = await consult();
    expect(H.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ _id: 'sindi' }),
        task: 'Find a flat in Gràcia under 1200',
        person,
        payerOxyUserId: 'person-1',
      }),
    );
    expect(events.map(([event]) => event)).toEqual([
      'alia.agent_start',
      'alia.agent_delta',
      'alia.agent_tool',
      'alia.agent_tool',
      'alia.agent_delta',
      'alia.agent_end',
    ]);
    const consultIds = new Set(events.map(([, data]) => data.consultId));
    expect(consultIds.size).toBe(1);
    expect(events[0]?.[1]).toMatchObject({
      eventVersion: 1,
      agent: { id: 'sindi', name: 'Sindi', handle: 'sindibot', color: 'teal' },
    });
    expect(events.at(-1)?.[1]).toMatchObject({ status: 'completed', content: 'Hay tres pisos.' });
    expect(result).toMatchObject({
      agentId: 'sindi',
      agentName: 'Sindi',
      response: 'Hay tres pisos.',
      creditsCharged: 1,
    });
  });

  it('refuses an agent the person could not open, and never runs it', async () => {
    H.reach = 'out_of_reach';
    const { events, result } = await consult();
    expect(result).toMatchObject({ error: 'Agent not found', response: '' });
    expect(H.turn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('never consults itself, nor an agent outside a named grant', async () => {
    expect((await consult({ callerAgentId: 'sindi' })).result).toMatchObject({
      error: 'That agent is not one you can consult',
    });
    expect((await consult({ allowedAgentIds: ['other'] })).result).toMatchObject({
      error: 'That agent is not one you can consult',
    });
    expect((await consult({ allowedAgentIds: [] })).tools).toEqual({});
    expect(H.turn).not.toHaveBeenCalled();
  });

  it('ends a failed consultation visibly, without its error text on the wire', async () => {
    H.turn.mockImplementation(async () => ({
      response: '',
      tokensUsed: 0,
      creditsCharged: 0,
      error: 'Not enough credits to consult that agent',
    }));
    const { events, result } = await consult();
    expect(events.at(-1)).toEqual([
      'alia.agent_end',
      expect.objectContaining({ status: 'failed', error: { code: 'agent_unavailable' } }),
    ]);
    expect(result).toMatchObject({ error: 'Not enough credits to consult that agent' });
  });

  it("hands the outer turn's attachments to the callee's turn, where its gates apply", async () => {
    const attachments = [{ feature: 'attachments.documents' as const, operationKey: 'K1' }];
    await consult({ attachments });
    expect(H.turn).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
  });

  it("ends a consultation the callee's gate refused with the typed code and feature", async () => {
    H.turn.mockImplementation(async () => ({
      response: '',
      tokensUsed: 0,
      creditsCharged: 0,
      error: 'This agent needs an upgrade in its app…',
      refusal: {
        code: 'feature_entitlement_required',
        feature: 'attachments.documents',
        retryable: false,
      },
    }));
    const { events, result } = await consult();
    expect(events.at(-1)).toEqual([
      'alia.agent_end',
      expect.objectContaining({
        status: 'failed',
        error: { code: 'feature_entitlement_required', feature: 'attachments.documents' },
      }),
    ]);
    expect(result).toMatchObject({
      errorCode: 'feature_entitlement_required',
      feature: 'attachments.documents',
    });
  });

  it('hands the turn the agent’s message, and nothing when it did not answer', async () => {
    const answers: AgentMessage[] = [];
    await consult({ answers });
    expect(answers).toEqual([
      {
        role: 'assistant',
        content: 'Hay tres pisos.',
        agentInfo: {
          id: 'sindi',
          name: 'Sindi',
          color: 'teal',
          character: null,
          handle: 'sindibot',
        },
      },
    ]);

    H.turn.mockImplementation(async () => ({
      response: '',
      tokensUsed: 0,
      creditsCharged: 0,
      error: 'no credits',
    }));
    await consult({ answers });
    expect(answers).toHaveLength(1);
  });

  it('stores and shares a drawing past the tool budget whole, while the lead reads a bounded result', async () => {
    const BUDGET = getToolResultBudget(128_000);
    const report = `# Pisos en Gràcia\n\n${'Un piso luminoso cerca de la plaza. '.repeat(1_000)}`;
    expect(report.length).toBeGreaterThan(BUDGET);
    const drawn = {
      toolCallId: 'c1',
      toolName: 'canvas',
      state: 'result',
      args: { type: 'markdown', title: 'Gràcia', data: { content: report } },
      result: { id: 'u', type: 'markdown', title: 'Gràcia', data: { content: report } },
    };
    const response = 'Hay tres pisos. '.repeat(2_000);
    H.turn.mockImplementation(async () => ({
      response,
      tokensUsed: 42,
      creditsCharged: 1,
      canvas: [drawn],
    }));
    const answers: AgentMessage[] = [];
    const tools = await buildConsultAgentTool({
      person,
      payerOxyUserId: 'person-1',
      callerAgentId: null,
      answers,
    });
    // Through the budget every turn's tools get (`tool-pipeline.ts` → `withBudget`).
    const bounded = wrapToolsWithTruncation(tools, BUDGET).consultAgent as unknown as Executable;
    const result = await bounded.execute({ agentId: 'sindi', task: 'Pisos en Gràcia' });

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(BUDGET + 64);
    expect(JSON.stringify(result)).not.toContain('Pisos en Gràcia');

    expect(answers[0]?.content).toBe(response);
    expect(answers[0]?.toolInvocations).toEqual([drawn]);
    const [shared] = sharedMessagesOf([
      {
        id: 'r',
        conversationId: 'c',
        oxyUserId: 'person-1',
        clientMessageId: 'a-1-agent-0',
        role: 'assistant',
        content: answers[0]?.content ?? '',
        vote: null,
        reactions: null,
        toolInvocations: answers[0]?.toolInvocations ?? null,
        agentInfoId: 'sindi',
        agentInfoName: 'Sindi',
        agentInfoColor: 'teal',
        agentInfoCharacter: null,
        agentInfoHandle: 'sindibot',
        seq: 1,
        interruptedAfterMs: null,
        createdAt: new Date(0),
      },
    ]);
    expect(shared?.artifacts).toEqual([
      { id: 'c1', type: 'markdown', title: 'Gràcia', data: { content: report } },
    ]);
  });
});
