/**
 * The canvas artifacts a nested turn draws come back with its answer (`AgentTurnResult.canvas`), so
 * the consulted agent's own message keeps them: a reload and a share show them where they were drawn
 * live. Only finished `canvas` calls: every other tool's result is the person's data and stays out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ parts: [] as object[] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: () => ({
      fullStream: (async function* () {
        yield* H.parts;
      })(),
      totalUsage: Promise.resolve({ totalTokens: 3, inputTokens: 1, outputTokens: 2 }),
      providerMetadata: Promise.resolve(undefined),
      steps: Promise.resolve([{ toolResults: [] }]),
      response: Promise.resolve({ messages: [] }),
    }),
  };
});
vi.mock('../../chat-core.js', () => ({
  resolveStoredModel: async () => ({ modelId: 'acme/chat-1', catalogue: null }),
  getAIModel: () => ({}),
}));
vi.mock('../../tool-pipeline.js', () => ({
  ToolPipeline: {
    forUser: async () => ({
      tools: {},
      routing: {},
      appCatalogPrompt: '',
      toolNameMapping: new Map(),
    }),
  },
}));
vi.mock('../../product-credit-access', () => ({
  reserveBackgroundProductCredits: async () => ({ id: 'reservation' }),
}));
vi.mock('../../credits-manager.js', () => ({
  finalizeCredits: async () => ({ creditsCharged: 1 }),
  refundReservation: async () => undefined,
}));
vi.mock('../../external-agents/turn.js', () => ({
  isExternalAgent: async () => false,
  runExternalAgentTurn: async () => ({ response: '', tokensUsed: 0, creditsCharged: 0 }),
}));
vi.mock('../../agent/soul.js', () => ({ evolveAgentSoul: async () => undefined }));
vi.mock('../../agent/archetype-prompts.js', () => ({ agentRemitPrompt: () => 'REMIT' }));
vi.mock('../../agent/space-prompt.js', () => ({ agentSpacePrompt: async () => '' }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, credits: child } };
});

const { runAgentTurn } = await import('../agent-turn.js');

const SINDI = {
  _id: 'sindi',
  oxyAccountId: 'sindi-bot',
  ownerOxyAccountId: 'homiio',
  name: 'Sindi',
  modelId: null,
  featureGates: {},
  memoryStore: 'gemie',
  reach: 'grants',
  taskAuthority: 'session',
} as unknown as Parameters<typeof runAgentTurn>[0]['agent'];

const chartArgs = { type: 'chart', title: 'Rents', data: { chartType: 'bar' } };
const chart = { id: 'c-uuid', ...chartArgs, message: 'Canvas component created' };

const run = () =>
  runAgentTurn({
    agent: SINDI,
    task: 'Rents in Gràcia?',
    person: {
      oxyUserId: 'person-1',
      accessToken: 'TOKEN',
      isDirectSession: true,
      surfaceApplicationId: null,
    },
    payerOxyUserId: 'person-1',
  });

beforeEach(() => {
  H.parts = [];
});

describe('what a nested turn drew', () => {
  it('returns its finished canvas calls, in order, and no other tool', async () => {
    H.parts = [
      { type: 'tool-call', toolCallId: 'l1', toolName: 'oxy_homiio__searchListings', input: {} },
      {
        type: 'tool-result',
        toolCallId: 'l1',
        toolName: 'oxy_homiio__searchListings',
        output: { listings: ['private'] },
      },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'canvas', input: chartArgs },
      { type: 'tool-result', toolCallId: 'c1', toolName: 'canvas', output: chart },
      // Called, never finished: nothing was drawn.
      { type: 'tool-call', toolCallId: 'c2', toolName: 'canvas', input: chartArgs },
      { type: 'text-delta', text: 'Here is the chart.' },
    ];
    const result = await run();
    expect(result.response).toBe('Here is the chart.');
    expect(result.canvas).toEqual([
      { toolCallId: 'c1', toolName: 'canvas', state: 'result', args: chartArgs, result: chart },
    ]);
  });

  it('carries no canvas when it drew nothing', async () => {
    H.parts = [{ type: 'text-delta', text: 'No idea.' }];
    expect(await run()).not.toHaveProperty('canvas');
  });
});
