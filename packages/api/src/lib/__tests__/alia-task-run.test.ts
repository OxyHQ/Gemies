import { aliaGemie } from '../../__tests__/support/gemies.js';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  findRun: vi.fn(),
  findAgent: vi.fn(),
  findDefinition: vi.fn(),
  listSteps: vi.fn(),
  markRun: vi.fn(),
  memory: vi.fn(),
  oxyUser: vi.fn(),
  post: vi.fn(),
  resolveModel: vi.fn(),
  getModel: vi.fn(),
  forUser: vi.fn(),
  generate: vi.fn(),
  finalize: vi.fn(),
  refund: vi.fn(),
  notify: vi.fn(),
  actionSteps: vi.fn(),
  readTools: vi.fn(),
  agency: {
    createFirstPartyExecutionAuthorization: vi.fn(),
    issueCapabilityTicket: vi.fn(),
  },
  /** Every agency method the code reached for, whatever it is. */
  agencyUsed: [] as string[],
  markStep: vi.fn(),
}));

const database = { kind: 'test-db' };

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../db/agents/agentRepository.js', () => ({ findAgentById: state.findAgent }));
vi.mock('../agent-identity.js', () => ({ attachAgentIdentity: async (row: unknown) => row }));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  findAutomationRunById: state.findRun,
  findAutomationDefinitionById: state.findDefinition,
  listAutomationRunActionSteps: state.actionSteps,
  listAutomationRunSteps: state.listSteps,
  markAliaAutomationRun: state.markRun,
  markAutomationActionStep: state.markStep,
}));
vi.mock('../tools/oxy-services.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/oxy-services.js')>()),
  listOxyAccountReadTools: state.readTools,
}));
vi.mock('../../db/memory/userMemoryRepository.js', () => ({ findUserMemory: state.memory }));
vi.mock('../../lib/oxy.js', () => ({
  oxy: {
    users: { get: state.oxyUser },
    agency: new Proxy(state.agency, {
      get(target, property) {
        if (typeof property === 'string') state.agencyUsed.push(property);
        return Reflect.get(target, property);
      },
    }),
  },
}));
vi.mock('../agent/alia-outreach.js', () => ({ postAliaMessage: state.post }));
vi.mock('../chat-core.js', () => ({
  resolveDefaultModel: state.resolveModel,
  getAIModel: state.getModel,
}));
vi.mock('../tool-pipeline.js', () => ({ ToolPipeline: { forUser: state.forUser } }));
vi.mock('../credits-manager.js', () => ({
  finalizeCredits: state.finalize,
  safeRefund: state.refund,
}));
vi.mock('../notification-service.js', () => ({ sendNotification: state.notify }));
vi.mock('ai', () => ({
  generateText: state.generate,
  stepCountIs: (count: number) => ({ stepCount: count }),
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child } };
});

import {
  ALIA_TASK_LEASE_MS,
  ALIA_TASK_MAX_STEPS,
  WATCH_NOTHING_TO_REPORT,
  aliaRunScope,
  runAliaTask,
} from '../alia-task-run.js';
import { oxyRunScopeKey, type OxyToolExecutionContext } from '../tools/oxy-services.js';
import { callBoundTool } from '../tools/oxy-invocation.js';
import type { BoundTool } from '../tools/oxy-catalog-defs.js';

const RESERVATION = {
  userId: 'owner-1',
  creditsReserved: 10,
  initialFreeCredits: 100,
  initialPaidCredits: 0,
  grantKind: 'free',
};
const job = {
  runId: 'run-1',
  automationId: 'automation-1',
  userId: 'owner-1',
  creditReservation: RESERVATION,
} as never;

const taskInput = {
  objective: 'Track the latest releases from Meta',
  trigger: { type: 'schedule', occurrenceId: 'occ-1', occurredAt: '2026-09-30T09:00:00.000Z' },
  inputs: { instructions: 'Tell me when Meta announces something new' },
  actions: [],
  receivePreviousResult: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.findRun.mockResolvedValue({
    id: 'run-1',
    automationId: 'automation-1',
    selectedActorType: 'alia',
    selectedAgentId: ALIA_GEMIE_ID,
    status: 'planned',
  });
  state.findAgent.mockImplementation(async (_db: unknown, id: string) =>
    id === ALIA_GEMIE_ID ? aliaGemie() : null,
  );
  state.findDefinition.mockResolvedValue({
    id: 'automation-1',
    ownerAccountId: 'owner-1',
    objective: 'Track the latest releases from Meta',
    conversationId: 'conversation-1',
    inputs: {},
  });
  state.listSteps.mockResolvedValue([{ tool: 'alia.run', input: taskInput }]);
  state.markRun.mockResolvedValue(true);
  state.actionSteps.mockResolvedValue([]);
  state.readTools.mockResolvedValue([]);
  state.markStep.mockResolvedValue(undefined);
  state.memory.mockResolvedValue(null);
  state.oxyUser.mockResolvedValue({ id: 'owner-1', username: 'nate' });
  state.post.mockResolvedValue({
    posted: true,
    conversationId: 'conversation-1',
    messageId: 'agent-push-1',
  });
  state.resolveModel.mockReturnValue({ modelId: 'auto' });
  state.getModel.mockReturnValue({ model: 'handle' });
  state.forUser.mockResolvedValue({ tools: { webSearch: {} }, routing: {}, appCatalogPrompt: '' });
  state.generate.mockResolvedValue({
    text: 'Meta announced Llama 5 today.',
    totalUsage: { inputTokens: 1200, outputTokens: 300 },
    steps: [{ toolResults: [] }],
    // The model Oxy chose for the `auto` level, as the adapter reports it.
    providerMetadata: { kaana: { resolvedModelReference: 'publisher/default-model@2026-09-01' } },
  });
  state.finalize.mockResolvedValue({ creditsCharged: 3, creditsRemaining: 97 });
  state.refund.mockResolvedValue(undefined);
  state.notify.mockResolvedValue(undefined);
});

describe('an Alia task run', () => {
  it('runs one Alia turn for the owner and posts the answer into the task conversation', async () => {
    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('completed');

    expect(state.resolveModel).toHaveBeenCalledWith();
    expect(state.forUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        actsForPerson: true,
        isDirectSession: false,
        agent: expect.objectContaining({ _id: ALIA_GEMIE_ID, taskAuthority: 'standing' }),
        toolsEnabled: true,
        webSearch: true,
        runId: 'run-1',
        // Nothing the owner's apps offer and nothing declared: an empty scope builds no Oxy tools.
        oxyRunScope: {},
      }),
    );
    expect(state.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { model: 'handle' },
        stopWhen: { stepCount: ALIA_TASK_MAX_STEPS },
        messages: [
          expect.objectContaining({ role: 'system' }),
          { role: 'user', content: expect.stringContaining('Track the latest releases from Meta') },
        ],
      }),
    );
    expect(state.finalize).toHaveBeenCalledWith(
      RESERVATION,
      { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
      'publisher/default-model',
    );
    expect(state.markRun).toHaveBeenNthCalledWith(1, database, 'run-1', 'running', {
      leaseMs: ALIA_TASK_LEASE_MS,
    });
    expect(state.markRun).toHaveBeenLastCalledWith(database, 'run-1', 'succeeded');
    expect(state.post).toHaveBeenCalledWith({
      oxyUserId: 'owner-1',
      automationId: 'automation-1',
      agentId: ALIA_GEMIE_ID,
      objective: 'Track the latest releases from Meta',
      conversationId: 'conversation-1',
      content: 'Meta announced Llama 5 today.',
    });
    expect(state.refund).not.toHaveBeenCalled();
  });

  it('drives only a run of a standing-authority gemie: any other is failed and refunded, unrun', async () => {
    state.findRun.mockResolvedValueOnce({
      id: 'run-1',
      automationId: 'automation-1',
      selectedActorType: 'alia',
      selectedAgentId: 'a-persona',
      status: 'planned',
    });
    state.findAgent.mockResolvedValueOnce({
      ...aliaGemie(),
      _id: 'a-persona',
      taskAuthority: 'session',
    });

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('failed');
    expect(state.forUser).not.toHaveBeenCalled();
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Standing-authority gemie not found');
  });

  it('keeps the hold for the retry when an earlier attempt fails', async () => {
    state.generate.mockRejectedValueOnce(new Error('upstream unavailable'));

    await expect(runAliaTask(job, { finalAttempt: false })).rejects.toThrow('upstream unavailable');
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.markRun).not.toHaveBeenCalledWith(database, 'run-1', 'failed');
    expect(state.post).not.toHaveBeenCalled();
  });

  it('refunds, fails the run and tells the person in the task conversation on the last attempt', async () => {
    state.generate.mockRejectedValueOnce(new Error('upstream unavailable'));

    await expect(runAliaTask(job, { finalAttempt: true })).rejects.toThrow('upstream unavailable');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Alia task failed');
    expect(state.markRun).toHaveBeenLastCalledWith(database, 'run-1', 'failed');
    expect(state.finalize).not.toHaveBeenCalled();
    expect(state.post).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        content: expect.stringContaining("couldn't complete this scheduled task"),
      }),
    );
    // The raw upstream reason never reaches the person.
    expect(JSON.stringify(state.post.mock.calls)).not.toContain('upstream');
  });

  it('falls back to a notification when the failure cannot be posted', async () => {
    state.generate.mockRejectedValueOnce(new Error('upstream unavailable'));
    state.post.mockRejectedValueOnce(new Error('database unreachable'));

    await expect(runAliaTask(job, { finalAttempt: true })).rejects.toThrow('upstream unavailable');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Alia task failed');
    expect(state.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        data: expect.objectContaining({
          automationId: 'automation-1',
          runId: 'run-1',
          status: 'failed',
        }),
      }),
    );
  });

  it('does not rerun or recharge a run that already settled', async () => {
    state.findRun.mockResolvedValueOnce({
      id: 'run-1',
      automationId: 'automation-1',
      selectedActorType: 'alia',
      status: 'succeeded',
    });

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('skipped');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
  });

  it('gives the hold back when the task was deleted before it ran', async () => {
    state.findDefinition.mockResolvedValueOnce(null);

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('failed');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.markRun).toHaveBeenCalledWith(database, 'run-1', 'failed');
    expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Alia task definition not found');
  });

  it("acts in the owner's apps within the run scope it builds when it runs", async () => {
    const inbox = {
      appId: 'inbox',
      effectiveAccountId: 'owner-1',
      resourceType: 'email_account',
      resourceId: 'owner-1',
    };
    state.findDefinition.mockResolvedValueOnce({
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      objective: 'Summarise my email',
      conversationId: 'conversation-1',
      maximumAutonomy: 'autonomous',
      inputs: {},
    });
    state.readTools.mockResolvedValueOnce([
      { resource: inbox, tool: 'listEmails' },
      { resource: inbox, tool: 'sendEmail' },
    ]);
    state.actionSteps.mockResolvedValueOnce([
      {
        stepId: 'step-2',
        automationActionId: 'action-2',
        resource: inbox,
        tool: 'sendEmail',
        limits: [{ key: 'recipients', value: 1 }],
      },
    ]);

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('completed');
    expect(state.readTools).toHaveBeenCalledWith('owner-1');
    expect(state.actionSteps).toHaveBeenCalledWith(database, 'run-1');
    const options = state.forUser.mock.calls[0]?.[0] as {
      oxyAutonomy: string;
      oxyRunScope: Record<string, unknown>;
      onOxyStepStatus: (stepId: string, status: string, audit?: string) => Promise<void>;
    };
    expect(options.oxyAutonomy).toBe('autonomous');
    // Every read of the owner's apps, repeatable; a declared action once, with its step and
    // limits, and it wins over the read of the same tool.
    expect(options.oxyRunScope).toEqual({
      [oxyRunScopeKey(inbox, 'listEmails')]: { repeatable: true },
      [oxyRunScopeKey(inbox, 'sendEmail')]: {
        stepId: 'step-2',
        repeatable: false,
        limits: [{ key: 'recipients', value: 1 }],
      },
    });
    await options.onOxyStepStatus('step-2', 'succeeded', 'audit-1');
    expect(state.markStep).toHaveBeenCalledWith(database, 'step-2', 'succeeded', 'audit-1');
  });

  it('still runs, with the declared actions, when the catalogue cannot list the reads', async () => {
    state.readTools.mockRejectedValueOnce(new Error('catalogue down'));
    const resource = {
      appId: 'inbox',
      effectiveAccountId: 'owner-1',
      resourceType: 'email_account',
      resourceId: 'owner-1',
    };
    state.actionSteps.mockResolvedValueOnce([
      { stepId: 's', automationActionId: 'a', resource, tool: 'sendEmail', limits: [] },
    ]);
    expect(await aliaRunScope('owner-1', 'run-1')).toEqual({
      [oxyRunScopeKey(resource, 'sendEmail')]: { stepId: 's', repeatable: false, limits: [] },
    });
  });

  it('gives a watch run no app reads: it reads only the open web', async () => {
    state.readTools.mockClear();
    state.actionSteps.mockResolvedValueOnce([]);
    expect(await aliaRunScope('owner-1', 'run-1', { reads: false })).toEqual({});
    expect(state.readTools).not.toHaveBeenCalled();
  });

  it('authorizes each scoped call as it is made, on first-party authority, with no task', async () => {
    const resource = {
      appId: 'inbox',
      effectiveAccountId: 'owner-1',
      resourceType: 'email_account',
      resourceId: 'owner-1',
    };
    state.agencyUsed.length = 0;
    state.agency.createFirstPartyExecutionAuthorization.mockResolvedValueOnce({ id: 'auth-1' });
    // Refused at the ticket: the call stops there, which is all this test needs to see.
    state.agency.issueCapabilityTicket.mockResolvedValueOnce({
      decision: { allowed: false, reason: 'test_stop' },
    });
    const binding = {
      resource,
      suffix: null,
      compiled: {
        definition: { name: 'sendEmail', effect: 'write' },
        catalogBinding: { registrationId: 'reg-1', version: '1.0.0', digest: 'a'.repeat(64) },
        catalog: { appId: 'inbox' },
      },
    } as unknown as BoundTool;
    const context: OxyToolExecutionContext = {
      requesterAccountId: 'owner-1',
      ownerAccountId: 'owner-1',
      actor: { type: 'alia', ownerAccountId: 'owner-1' },
      runId: 'run-1',
      autonomy: 'autonomous',
      runScope: {
        [oxyRunScopeKey(resource, 'sendEmail')]: {
          stepId: 'step-2',
          repeatable: false,
          limits: [{ key: 'recipients', value: 1 }],
        },
      },
    };

    await expect(callBoundTool(binding, { to: 'a@b.c' }, context)).rejects.toThrow();

    expect(state.agency.createFirstPartyExecutionAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: 'first_party',
        kind: 'direct_request',
        actor: { type: 'alia', ownerAccountId: 'owner-1' },
        resource,
        tool: 'sendEmail',
        runId: 'run-1',
        stepId: 'step-2',
        limits: [{ tool: 'sendEmail', key: 'recipients', value: 1 }],
      }),
      { requesterAccountId: 'owner-1' },
    );
    // The authorization bound its own run and step; the ticket request names neither.
    expect(state.agency.issueCapabilityTicket).toHaveBeenCalledWith({
      executionAuthorizationId: 'auth-1',
    });
    // Nothing else of Oxy's agency: no task, no requester-bound authorization.
    expect(new Set(state.agencyUsed)).toEqual(
      new Set(['createFirstPartyExecutionAuthorization', 'issueCapabilityTicket']),
    );
  });

  it('charges a watch run but posts nothing when the change is not worth telling', async () => {
    state.listSteps.mockResolvedValueOnce([
      {
        tool: 'alia.run',
        input: {
          ...taskInput,
          trigger: { ...taskInput.trigger, watch: { source: { query: 'Meta' }, newResults: [] } },
        },
      },
    ]);
    state.generate.mockResolvedValueOnce({
      text: WATCH_NOTHING_TO_REPORT,
      totalUsage: { inputTokens: 100, outputTokens: 5 },
      steps: [{ toolResults: [] }],
    });

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('completed');
    const system = (state.generate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> })
      .messages[0]?.content;
    expect(system).toContain(WATCH_NOTHING_TO_REPORT);
    expect(state.finalize).toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  });

  it('does not run a run the reaper already closed', async () => {
    state.markRun.mockResolvedValueOnce(false);

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('skipped');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
  });

  it('neither charges nor posts when the reaper closed the run while it ran', async () => {
    state.markRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(runAliaTask(job, { finalAttempt: true })).resolves.toBe('skipped');
    expect(state.finalize).not.toHaveBeenCalled();
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  });

  it('does not refund twice when the reaper failed the run first', async () => {
    state.generate.mockRejectedValueOnce(new Error('upstream unavailable'));
    state.markRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(runAliaTask(job, { finalAttempt: true })).rejects.toThrow('upstream unavailable');
    expect(state.refund).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  });

  describe('a run that ends without a word', () => {
    beforeEach(() => {
      state.generate.mockResolvedValue({
        text: '   ',
        totalUsage: { inputTokens: 1200, outputTokens: 300 },
        steps: [{ toolResults: [] }],
      });
    });

    it('is a typed failure the queue retries, not a filler message', async () => {
      await expect(runAliaTask(job, { finalAttempt: false })).rejects.toMatchObject({
        code: 'EMPTY_RESPONSE',
      });

      // Neither charged nor closed: the retry starts from the same hold.
      expect(state.finalize).not.toHaveBeenCalled();
      expect(state.markRun).not.toHaveBeenCalledWith(database, 'run-1', 'succeeded');
      expect(state.refund).not.toHaveBeenCalled();
      expect(state.post).not.toHaveBeenCalled();
    });

    it('on the last attempt refunds, fails the run and tells the person it did not run', async () => {
      await expect(runAliaTask(job, { finalAttempt: true })).rejects.toMatchObject({
        code: 'EMPTY_RESPONSE',
      });

      expect(state.refund).toHaveBeenCalledWith(RESERVATION, 'Alia task failed');
      expect(state.markRun).toHaveBeenLastCalledWith(database, 'run-1', 'failed');
      expect(state.post).toHaveBeenCalledTimes(1);
      expect(state.post).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("couldn't complete this scheduled task"),
        }),
      );
      expect(JSON.stringify(state.post.mock.calls)).not.toContain('Task finished.');
    });
  });
});
