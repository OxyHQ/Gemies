import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A run that stops short of an answer (its token budget, its steps, its time) writes the answer
 * from what it found, and its status line never becomes the gemie's message.
 *
 * Production, 2026-11-14: Eusebio was asked "Salúdame en un minuto con un resumen de mi email".
 * The follow-up run loaded Inbox's tools (one step), listed the unread emails, read the first
 * 2,000 characters of an escaped JSON preview (no email in it), listed them again and again, and
 * after seven steps spent its 100,000 tokens. Its result, "Token budget exhausted. Partial progress
 * was made.", was delivered to the person as the gemie's message.
 */

const H = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  script: [] as Array<() => unknown>,
  updates: [] as Array<Record<string, unknown>>,
  observed: [] as string[],
  pipeline: null as null | Record<string, unknown>,
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(async (config: Record<string, unknown>) => {
    H.calls.push(config);
    const next = H.script.shift();
    if (!next) throw new Error('no scripted answer left');
    return next();
  }),
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child } };
});
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/eventStreamEntryRepository.js', () => ({
  appendEventStreamEntries: async (
    _db: unknown,
    _session: string,
    entries: Array<{ type: string; content: string }>,
  ) => {
    for (const entry of entries) if (entry.type === 'observation') H.observed.push(entry.content);
  },
  listEventStreamEntries: async () => [],
}));
vi.mock('../../realtime/activity.js', () => ({
  startActorActivity: () => ({ set: () => undefined, end: () => undefined }),
}));
vi.mock('../activity-events.js', () => ({
  emitAgentActivity: () => undefined,
  emitLegacyAliaActivity: () => undefined,
}));
vi.mock('../work.js', () => ({ autonomousWorkMayRun: async () => true }));
vi.mock('../../oxy-task-authority.js', () => ({ retireFinishedOxyTasks: async () => undefined }));
vi.mock('../../agent-account.js', () => ({ canReachAgent: async () => 'reachable' }));
vi.mock('../../../db/agents/agentSessionRepository.js', () => ({
  RUNNER_MAX_ATTEMPTS: 3,
  claimAgentSessionRun: async () => ({ claimed: true, attempt: 1, session: SESSION() }),
  releaseAgentSessionRunLease: async () => undefined,
  findAgentSessionStatus: async () => 'running',
  findAgentSessionById: async () => null,
  createAgentSession: async () => ({ _id: 'child' }),
  updateAgentSession: async (_db: unknown, _id: string, values: Record<string, unknown>) => {
    H.updates.push(values);
  },
}));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: async () => ({
    _id: 'eusebio',
    id: 'eusebio',
    modelId: null,
    capabilityGrants: [],
  }),
}));
vi.mock('../../chat-core.js', () => ({
  resolveStoredModel: async () => ({ modelId: 'acme/chat-1', catalogue: null }),
  getAIModel: () => 'model',
}));
vi.mock('../../tool-pipeline.js', () => ({
  ToolPipeline: {
    forUser: async (params: Record<string, unknown>) => {
      H.pipeline = params;
      return { tools: {}, routing: {}, appCatalogPrompt: '' };
    },
  },
}));
vi.mock('../../tools/oxy-services.js', () => ({
  agentIdentityPrompt: () => '',
  oxyExecutionAuthorizationKey: () => 'key',
}));
vi.mock('../space-prompt.js', () => ({ agentSpacePrompt: async () => '' }));
vi.mock('../../agent-identity.js', () => ({
  agentPromptName: () => 'Eusebio',
  attachAgentIdentity: async (agent: unknown) => agent,
  findAgentByOxyHandle: async () => null,
}));
vi.mock('../../identity-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../identity-guard.js')>()),
  buildIdentityGuard: () => 'You are Eusebio.',
}));
vi.mock('../../credits-manager.js', () => ({
  finalizeCredits: async () => ({ creditsCharged: 1 }),
  safeRefund: async () => undefined,
}));
vi.mock('../orchestrator.js', () => ({ shouldOrchestrate: () => false, orchestrate: vi.fn() }));
vi.mock('../agent-outreach.js', () => ({ postAgentMessage: vi.fn() }));
vi.mock('../follow-ups.js', () => ({ followUpReceipt: vi.fn(), scheduleAgentFollowUp: vi.fn() }));
vi.mock('../work-delivery.js', () => ({
  requestedAgentWork: async () => true,
  requestedWorkPriorToolCalls: async () => [{ toolName: 'oxy_inbox__getUnreadEmails' }],
}));
vi.mock('../agent-memory-runtime.js', () => ({ agentMemoryPromptSection: async () => '' }));
vi.mock('../../computer/computer-actor.js', () => ({ resolveComputerActor: () => null }));
vi.mock('../context-compaction.js', () => ({ compactContext: async () => undefined }));
vi.mock('../../../db/automation/automationDefinitionRepository.js', () => ({
  listAutomationExecutionAuthorizationsForRun: async () => [],
  markAutomationActionStep: async () => undefined,
  markAutomationRunForSession: async () => undefined,
}));
vi.mock('../run-lease.js', () => ({
  holdRunLease: () => ({ lost: false, stop: () => undefined }),
}));
vi.mock('../../gemie-oxy-actor.js', () => ({ runtimeGemieAccountId: () => 'eusebio-account' }));

function SESSION() {
  return {
    _id: 'run-1',
    id: 'run-1',
    agentId: 'eusebio',
    oxyUserId: 'nate',
    threadId: null,
    conversationId: null,
    goalId: null,
    workItemId: 'work-1',
    generation: 1,
    parentSessionId: null,
    oxyTaskId: 'task-1',
    automationRunId: null,
    automationStage: null,
    status: 'running',
    task: 'Saluda al usuario con un resumen de su email.',
    result: null,
    messages: [],
    eventStream: [],
    stats: { totalSteps: 0, totalTokens: 0 },
    config: { maxSteps: 50, maxTokens: 30_000, maxVMs: 1 },
    depth: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Twenty unread emails as Inbox returns them: mostly ids and empty fields. */
const UNREAD = {
  data: Array.from({ length: 20 }, (_, index) => ({
    _id: `e${index}`,
    id: `e${index}`,
    userId: 'nate',
    from: { name: `Sender ${index}`, address: `s${index}@example.com` },
    subject: `Subject ${index}`,
    cc: [],
    bcc: [],
    labels: [],
    inReplyTo: null,
    aliasTag: null,
    date: '2026-11-14T01:08:57.000Z',
  })),
};

/** One step of the loop: a tool call that lists the unread emails, at `tokens`. */
const listsEmails = (tokens: number) => () => ({
  text: '',
  usage: { totalTokens: tokens },
  steps: [
    {
      toolCalls: [{ toolName: 'oxy_inbox__getUnreadEmails', input: { limit: 20 } }],
      toolResults: [{ toolName: 'oxy_inbox__getUnreadEmails', output: UNREAD }],
    },
  ],
});

const { runAgentSession } = await import('../runner.js');
const { SYNTHESIS_REQUEST } = await import('../../chat/tool-synthesis.js');

beforeEach(() => {
  H.calls = [];
  H.script = [];
  H.updates = [];
  H.observed = [];
  H.pipeline = null;
});
afterEach(() => vi.clearAllMocks());

const settled = () => H.updates.at(-1) ?? {};

describe('a run that reaches its token budget', () => {
  it('writes its answer from what it found, without tools, within the budget', async () => {
    H.script = [
      listsEmails(12_000),
      listsEmails(12_000),
      () => ({ text: 'Hola Nate 👋 Tienes 20 emails sin leer.', usage: { totalTokens: 3_000 } }),
    ];

    await runAgentSession('run-1');

    // Two steps, then no third: the budget had room for one more call, which is the answer.
    expect(H.calls).toHaveLength(3);
    const answer = H.calls[2] as { tools?: unknown; messages: Array<{ content: unknown }> };
    expect(answer.tools).toBeUndefined();
    expect(answer.messages.at(-1)?.content).toBe(SYNTHESIS_REQUEST);
    expect(settled()).toMatchObject({
      status: 'completed',
      result: 'Hola Nate 👋 Tienes 20 emails sin leer.',
    });
    expect(JSON.stringify(H.updates)).not.toContain('Token budget exhausted');
  });

  it('fails, never "completed" with its status line, when it cannot write one', async () => {
    H.script = [listsEmails(12_000), listsEmails(12_000), () => ({ text: '', usage: {} })];

    await runAgentSession('run-1');

    expect(settled()).toMatchObject({
      status: 'failed',
      result: 'Stopped at the token budget without an answer',
    });
  });
});

describe('what a run sees of a tool result', () => {
  it('keeps the whole result as JSON it can read, not its first 2,000 characters', async () => {
    H.script = [
      listsEmails(1_000),
      () => ({ text: 'Tienes 20 emails.', usage: { totalTokens: 1_000 }, steps: [] }),
      () => ({ text: 'Tienes 20 emails.', usage: { totalTokens: 1_000 }, steps: [] }),
    ];

    await runAgentSession('run-1');

    expect(H.observed[0]?.length).toBeGreaterThan(2_000);
    expect(JSON.parse(H.observed[0] ?? 'null')).toEqual(UNREAD);
  });

  it('starts with the tools its conversation used, instead of a step loading them', async () => {
    H.script = [() => ({ text: 'Hola.', usage: { totalTokens: 100 }, steps: [] })];
    H.script.push(H.script[0] as () => unknown);

    await runAgentSession('run-1');

    expect(H.pipeline?.priorToolCalls).toEqual([{ toolName: 'oxy_inbox__getUnreadEmails' }]);
  });
});
