import express from 'express';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie.js';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  token: 'user-token' as string | undefined,
  create: vi.fn(),
  dispatch: vi.fn(),
  find: vi.fn(),
  setEnabled: vi.fn(),
  update: vi.fn(),
  reload: vi.fn(),
  scheduleError: vi.fn(),
  tooFrequent: vi.fn(() => false),
  enabledCount: vi.fn(async () => 0),
  oxyMap: vi.fn(),
  list: vi.fn(),
  readTools: vi.fn(),
}));

const database = { transaction: vi.fn(async (callback) => callback(database)) };

// Where an agent opens (ADR 0021) is `app-confined-agents.test.ts`'s subject, not this file's.
vi.mock('../../lib/agent-availability.js', () => ({ agentOpensOn: async () => 'reachable' }));
vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (
    request: express.Request,
    _response: express.Response,
    next: express.NextFunction,
  ) => {
    request.user = { id: 'owner-1' };
    request.accessToken = state.token;
    next();
  },
}));
vi.mock('../../db/agents/agentRepository.js', async () => {
  const { aliaGemie } = await import('../../__tests__/support/gemies.js');
  const { ALIA_GEMIE_ID } = await import('../../domain/alia-gemie.js');
  return {
    findAgentById: vi.fn(async (_db, id: string) =>
      id === ALIA_GEMIE_ID
        ? aliaGemie()
        : {
            id,
            _id: id,
            ownerOxyAccountId: 'owner-1',
            access: 'private',
            identity: { source: 'oxy', oxyAccountId: `bot-${id}` },
            status: 'active',
            taskAuthority: 'session',
          },
    ),
  };
});
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  countEnabledAutomationDefinitions: state.enabledCount,
  createAutomationDefinition: state.create,
  findAutomationDefinition: state.find,
  listAutomationDefinitions: state.list,
  listAutomationRuns: vi.fn(async () => []),
  listAutomationRunSteps: vi.fn(async () => []),
  setAutomationEnabled: state.setEnabled,
  updateAutomationDefinition: state.update,
}));
vi.mock('../../lib/automation-dispatcher.js', () => ({
  dispatchStructuredAutomation: state.dispatch,
}));
vi.mock('../../lib/tools/oxy-services.js', () => ({
  getOxyAgentCapabilityMap: state.oxyMap,
  listOxyAccountReadTools: state.readTools,
}));
vi.mock('../../lib/trigger-engine.js', () => ({
  automationScheduleError: state.scheduleError,
  automationScheduleTooFrequent: state.tooFrequent,
  reloadAutomationSchedule: state.reload,
}));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { triggers: child } };
});

const { default: router } = await import('../automations.js');

let server: Server;
let port: number;

function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const json = body === undefined ? '' : JSON.stringify(body);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...headers,
          ...(json
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(json)),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(json);
  });
}

const resource = {
  appId: 'inbox',
  effectiveAccountId: 'owner-1',
  resourceType: 'mailbox',
  resourceId: 'mailbox-1',
};
const payload = {
  objective: 'Reply to important email',
  trigger: { type: 'event', appId: 'inbox', eventType: 'email_needs_response', resource },
  actorSelection: { mode: 'fixed', agentId: 'agent-1' },
  actions: [{ resource, tool: 'replyToEmail', input: {}, limits: [] }],
  resources: [resource],
  dataFlow: { sources: [resource], destinations: [resource] },
  maximumAutonomy: 'autonomous',
};

function storedAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'automation-1',
    ownerAccountId: 'owner-1',
    objective: payload.objective,
    trigger: payload.trigger,
    actorSelection: payload.actorSelection,
    executionMode: 'execute',
    actions: [{ id: 'action-1', position: 0, ...payload.actions[0] }],
    inputs: {},
    resources: payload.resources,
    dataFlow: payload.dataFlow,
    maximumAutonomy: payload.maximumAutonomy,
    limits: [],
    enabled: true,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/automations', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no TCP port');
  port = address.port;
});

afterAll(
  async () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);

beforeEach(() => {
  vi.clearAllMocks();
  state.token = 'user-token';
  state.create.mockImplementation(async (_db, input) => ({
    id: input.id,
    ownerAccountId: input.ownerAccountId,
    objective: input.objective,
    trigger:
      input.triggerKind === 'event'
        ? {
            type: 'event',
            appId: input.eventAppId,
            eventType: input.eventType,
            resource: input.eventResource,
          }
        : { type: input.triggerKind },
    actorSelection: { mode: input.actorMode, agentId: input.fixedAgentId },
    executionMode: input.executionMode,
    actions: input.actions.map((action: Record<string, unknown>, position: number) => ({
      ...action,
      position,
    })),
    inputs: input.inputs,
    resources: input.resources,
    dataFlow: input.dataFlow,
    maximumAutonomy: input.maximumAutonomy,
    limits: input.limits,
    enabled: input.enabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  state.dispatch.mockResolvedValue({ status: 'queued', sessionId: 'session-1' });
  state.reload.mockResolvedValue(undefined);
  state.scheduleError.mockReturnValue(null);
  state.tooFrequent.mockReturnValue(false);
  state.enabledCount.mockResolvedValue(0);
  state.oxyMap.mockResolvedValue([
    {
      resource,
      maximumAutonomy: 'autonomous',
      limits: [],
      toolNames: ['replyToEmail'],
    },
  ]);
  state.setEnabled.mockImplementation(async (_db, id, _owner, enabled) => ({ id, enabled }));
  state.list.mockResolvedValue([]);
  state.update.mockImplementation(async (_db, input) =>
    storedAutomation({
      id: input.id,
      objective: input.objective,
      trigger:
        input.triggerKind === 'schedule'
          ? { type: 'schedule', cron: input.scheduleCron, timezone: input.scheduleTimezone }
          : input.triggerKind === 'event'
            ? {
                type: 'event',
                appId: input.eventAppId,
                eventType: input.eventType,
                resource: input.eventResource,
              }
            : { type: 'manual' },
      actorSelection:
        input.actorMode === 'fixed'
          ? { mode: 'fixed', agentId: input.fixedAgentId }
          : { mode: 'automatic', eligibleAgentIds: input.eligibleAgentIds },
      resources: input.resources,
      dataFlow: input.dataFlow,
      maximumAutonomy: input.maximumAutonomy,
      limits: input.limits,
      enabled: input.enabled,
      updatedAt: new Date('2026-09-01T10:02:00.000Z'),
    }),
  );
});

describe('structured automation control plane', () => {
  it('defaults to observation without creating Oxy execution authority', async () => {
    const response = await send('POST', '/automations', payload);
    expect(response.status).toBe(201);
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        executionMode: 'observe',
        actions: [expect.objectContaining({ tool: 'replyToEmail' })],
      }),
    );
    expect(response.body.receipt).toEqual(
      expect.objectContaining({
        executionMode: 'observe',
        actions: [expect.objectContaining({ tool: 'replyToEmail' })],
      }),
    );
  });

  it('creates an execute definition with no user session: nothing is provisioned at Oxy', async () => {
    state.token = undefined;
    const response = await send('POST', '/automations', { ...payload, executionMode: 'execute' });
    expect(response.status).toBe(201);
    // Enabled at once: each run's calls are authorized when they are made (oxy ADR 0066).
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ executionMode: 'execute', enabled: true }),
    );
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it('creates an assistant task without a user token or fabricated app authority', async () => {
    state.token = undefined;
    const response = await send('POST', '/automations', {
      objective: 'Remind me to call Alex',
      trigger: { type: 'schedule', cron: '0 10 11 9 *', timezone: 'Europe/Bucharest' },
      actorSelection: { mode: 'fixed', agentId: 'agent-1' },
      executionMode: 'execute',
      actions: [],
      inputs: { instructions: 'Remind me to call Alex', runOnce: true },
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      maximumAutonomy: 'autonomous',
      limits: [],
      enabled: true,
    });

    expect(response.status).toBe(201);
    expect(state.oxyMap).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        actions: [],
        resources: [],
        enabled: true,
      }),
    );
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it('rejects an invalid schedule before persisting the definition', async () => {
    state.scheduleError.mockReturnValueOnce('invalid_timezone');
    const response = await send('POST', '/automations', {
      ...payload,
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Mars/Olympus' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_timezone');
    expect(state.create).not.toHaveBeenCalled();
  });

  it('rejects a schedule that would fire more often than every five minutes', async () => {
    state.tooFrequent.mockReturnValueOnce(true);
    const response = await send('POST', '/automations', {
      ...payload,
      trigger: { type: 'schedule', cron: '* * * * *', timezone: 'UTC' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('automation_schedule_too_frequent');
    expect(state.create).not.toHaveBeenCalled();
  });

  it('stops at the limit of enabled automations, and still lets a disabled one be saved', async () => {
    state.enabledCount.mockResolvedValue(100);
    const refused = await send('POST', '/automations', payload);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('too_many_automations');
    expect(state.create).not.toHaveBeenCalled();

    const saved = await send('POST', '/automations', { ...payload, enabled: false });
    expect(saved.status).toBe(201);
  });

  it('stores no bearer and no Oxy authorization with an execute definition', async () => {
    const response = await send('POST', '/automations', { ...payload, executionMode: 'execute' });
    expect(response.status).toBe(201);
    const persisted = state.create.mock.calls[0]?.[1];
    expect(persisted.enabled).toBe(true);
    expect(persisted).not.toHaveProperty('authorizations');
    expect(persisted).not.toHaveProperty('aliaAuthorizations');
    expect(JSON.stringify(persisted)).not.toContain('user-token');
    expect(state.reload).toHaveBeenCalledWith(persisted.id);
  });

  it('resolves manual authority at execute-on-request rather than autonomous level', async () => {
    const response = await send('POST', '/automations', {
      ...payload,
      trigger: { type: 'manual' },
      executionMode: 'execute',
      maximumAutonomy: 'execute_on_request',
    });

    expect(response.status).toBe(201);
    expect(state.oxyMap).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAccountId: 'owner-1',
        autonomy: 'execute_on_request',
      }),
    );
  });

  it('rejects active background execution below autonomous policy', async () => {
    const response = await send('POST', '/automations', {
      ...payload,
      executionMode: 'execute',
      maximumAutonomy: 'execute_on_request',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('background_execution_requires_autonomous_policy');
    expect(state.create).not.toHaveBeenCalled();
  });

  it('rejects manual execution under a draft policy', async () => {
    const response = await send('POST', '/automations', {
      ...payload,
      trigger: { type: 'manual' },
      executionMode: 'execute',
      maximumAutonomy: 'draft',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('manual_execution_requires_request_autonomy');
    expect(state.create).not.toHaveBeenCalled();
  });

  it('does not reactivate an execute definition with an incompatible policy', async () => {
    state.find.mockResolvedValue(
      storedAutomation({
        trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Madrid' },
        maximumAutonomy: 'draft',
        enabled: false,
      }),
    );

    const response = await send('PATCH', '/automations/automation-1', { enabled: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('background_execution_requires_autonomous_policy');
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it('edits every mutable field and returns a refreshed receipt', async () => {
    state.find.mockResolvedValue(storedAutomation({ executionMode: 'observe' }));
    const noted = { ...resource, appId: 'noted', resourceType: 'workspace', resourceId: 'notes-1' };
    const update = {
      objective: 'Prepare a weekly note digest',
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Madrid' },
      actorSelection: { mode: 'automatic', eligibleAgentIds: ['agent-2', 'agent-1'] },
      resources: [resource, noted],
      dataFlow: { sources: [resource], destinations: [noted] },
      maximumAutonomy: 'autonomous',
      limits: [{ key: 'weekly', value: 1 }],
      enabled: true,
    };

    const response = await send('PATCH', '/automations/automation-1', update);

    expect(response.status).toBe(200);
    expect(state.update).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        objective: update.objective,
        triggerKind: 'schedule',
        actorMode: 'automatic',
        eligibleAgentIds: ['agent-2', 'agent-1'],
        resources: [resource, noted],
        dataFlow: update.dataFlow,
        maximumAutonomy: 'autonomous',
        limits: update.limits,
        enabled: true,
        expectedUpdatedAt: new Date('2026-09-01T10:00:00.000Z'),
      }),
    );
    expect(response.body.receipt).toEqual(
      expect.objectContaining({
        objective: update.objective,
        trigger: update.trigger,
        actors: update.actorSelection,
        resources: update.resources,
        dataFlow: update.dataFlow,
        limits: update.limits,
        enabled: true,
      }),
    );
  });

  it('edits an execute definition in place, against the version it read', async () => {
    state.find.mockResolvedValue(storedAutomation());

    const response = await send('PATCH', '/automations/automation-1', {
      objective: 'Reply to urgent email only',
    });

    expect(response.status).toBe(200);
    // Nothing to stop, revoke or re-provision first: it stays enabled throughout.
    expect(state.setEnabled).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        objective: 'Reply to urgent email only',
        expectedUpdatedAt: new Date('2026-09-01T10:00:00.000Z'),
        enabled: true,
      }),
    );
    expect(response.body).not.toHaveProperty('revocation');
  });

  it('revalidates actor coverage against the newly assigned actor capability map', async () => {
    state.find.mockResolvedValue(storedAutomation());

    const response = await send('PATCH', '/automations/automation-1', {
      actorSelection: { mode: 'fixed', agentId: 'agent-2' },
    });

    expect(response.status).toBe(200);
    expect(state.oxyMap).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'agent', accountId: 'bot-agent-2' },
      }),
    );
    expect(state.update).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ fixedAgentId: 'agent-2' }),
    );
  });

  it('refuses an edit whose new actor cannot cover the declared action', async () => {
    state.find.mockResolvedValue(storedAutomation());
    state.oxyMap.mockResolvedValue([]);

    const response = await send('PATCH', '/automations/automation-1', {
      actorSelection: { mode: 'fixed', agentId: 'agent-2' },
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('automation_actor_coverage_missing');
    expect(state.update).not.toHaveBeenCalled();
  });

  it('rejects duplicate global limits before rotating authority', async () => {
    state.find.mockResolvedValue(storedAutomation());

    const response = await send('PATCH', '/automations/automation-1', {
      limits: [
        { key: 'daily', value: 5 },
        { key: 'daily', value: 10 },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_automation_patch');
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it('stops the task: disabling it is the off switch, with nothing held at Oxy', async () => {
    state.find.mockResolvedValue({
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      executionMode: 'execute',
      enabled: true,
    });
    const response = await send('DELETE', '/automations/automation-1');
    expect(response.status).toBe(200);
    expect(state.setEnabled).toHaveBeenCalledWith(database, 'automation-1', 'owner-1', false);
    expect(state.reload).toHaveBeenCalledWith('automation-1');
    expect(response.body).toEqual({
      automation: { id: 'automation-1', enabled: false },
      stopped: true,
    });
  });

  it('dispatches a manual definition with the caller and an explicit idempotency key', async () => {
    state.find.mockResolvedValue({
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      trigger: { type: 'manual' },
    });

    const response = await send('POST', '/automations/automation-1/run', undefined, {
      'idempotency-key': 'request-0001',
    });

    expect(response.status).toBe(202);
    expect(response.body.run).toEqual({ status: 'queued', sessionId: 'session-1' });
    expect(state.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'automation-1' }),
      expect.objectContaining({
        kind: 'manual',
        id: 'manual:automation-1:request-0001',
        requesterAccountId: 'owner-1',
      }),
    );
  });

  it('requires an idempotency key before reading or dispatching a manual definition', async () => {
    const response = await send('POST', '/automations/automation-1/run');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('valid_idempotency_key_required');
    expect(state.find).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });
});

describe('Alia as the default responsible actor', () => {
  const assistantTask = {
    objective: 'Track the latest releases from Meta',
    trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'Europe/Madrid' },
    executionMode: 'execute',
    actions: [],
    inputs: { instructions: 'Tell me when Meta announces something new' },
    resources: [],
    dataFlow: { sources: [], destinations: [] },
    maximumAutonomy: 'autonomous',
  };
  const inboxRoot = {
    appId: 'inbox',
    effectiveAccountId: 'owner-1',
    resourceType: 'email_account',
    resourceId: 'owner-1',
  };
  const reads = [
    { resource: inboxRoot, tool: 'listEmails' },
    { resource: inboxRoot, tool: 'getEmail' },
  ];

  beforeEach(() => {
    state.readTools.mockResolvedValue(reads);
  });

  it('makes Alia responsible when no actor is named, enabled at once', async () => {
    const response = await send('POST', '/automations', assistantTask);

    expect(response.status).toBe(201);
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        actorMode: 'fixed',
        fixedAgentId: ALIA_GEMIE_ID,
        eligibleAgentIds: [],
        actions: [],
        enabled: true,
      }),
    );
    expect(state.oxyMap).not.toHaveBeenCalled();
    // Her reads of the owner's apps are her run's scope, built when it runs (`aliaRunScope`).
    expect(state.readTools).not.toHaveBeenCalled();
  });

  it('creates an Alia task with no session at all', async () => {
    state.token = undefined;
    const response = await send('POST', '/automations', assistantTask);

    expect(response.status).toBe(201);
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ fixedAgentId: ALIA_GEMIE_ID, enabled: true }),
    );
  });

  it('accepts Alia named explicitly', async () => {
    const response = await send('POST', '/automations', {
      ...assistantTask,
      actorSelection: { mode: 'fixed', agentId: ALIA_GEMIE_ID },
    });

    expect(response.status).toBe(201);
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ actorMode: 'fixed', fixedAgentId: ALIA_GEMIE_ID }),
    );
  });

  it('keeps the exact connected actions an Alia task declares, with nothing provisioned', async () => {
    const { actorSelection: _agent, ...connected } = payload;
    const response = await send('POST', '/automations', { ...connected, executionMode: 'execute' });

    expect(response.status).toBe(201);
    expect(state.oxyMap).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        fixedAgentId: ALIA_GEMIE_ID,
        actions: [
          expect.objectContaining({ id: expect.any(String), resource, tool: 'replyToEmail' }),
        ],
        enabled: true,
      }),
    );
  });

  it('creates a watch with no app reads: it only looks at the open web', async () => {
    const response = await send('POST', '/automations', {
      ...assistantTask,
      trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'Europe/Madrid' },
      inputs: { watch: { query: 'Meta announces' } },
    });

    expect(response.status).toBe(201);
    expect(state.readTools).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ inputs: { watch: { query: 'Meta announces' } }, enabled: true }),
    );
  });

  it.each([
    [{ watch: { query: 'x', url: 'https://example.com' } }, undefined, 'invalid_watch'],
    [{ watch: { url: 'https://example.com', condition: 'contains' } }, undefined, 'invalid_watch'],
    [
      { watch: { query: 'Meta announces' } },
      { mode: 'fixed', agentId: 'agent-1' },
      'watch_requires_alia',
    ],
  ])('refuses a malformed watch %#', async (inputs, actorSelection, error) => {
    const response = await send('POST', '/automations', {
      ...assistantTask,
      inputs,
      ...(actorSelection ? { actorSelection } : {}),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('keeps an agent task as it was: a named owned agent still runs it', async () => {
    const response = await send('POST', '/automations', {
      ...assistantTask,
      actorSelection: { mode: 'fixed', agentId: 'agent-1' },
    });

    expect(response.status).toBe(201);
    expect(state.create).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        actorMode: 'fixed',
        fixedAgentId: 'agent-1',
      }),
    );
  });

  it('still refuses an automatic agent pool for an assistant task', async () => {
    const response = await send('POST', '/automations', {
      ...assistantTask,
      actorSelection: { mode: 'automatic', eligibleAgentIds: ['agent-1'] },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('assistant_task_requires_responsible_agent');
  });

  it('moves an existing agent task to Alia on update', async () => {
    const existing = storedAutomation({
      actorSelection: { mode: 'fixed', agentId: 'agent-1' },
      trigger: assistantTask.trigger,
      actions: [],
      resources: [],
      dataFlow: { sources: [], destinations: [] },
      executionMode: 'execute',
    });
    state.find.mockResolvedValueOnce(existing);
    state.setEnabled.mockImplementationOnce(async () => existing);
    state.update.mockImplementationOnce(async (_db, input) =>
      storedAutomation({
        ...existing,
        actorSelection: { mode: input.actorMode, agentId: input.fixedAgentId },
      }),
    );

    const response = await send('PATCH', '/automations/automation-1', {
      actorSelection: { mode: 'fixed', agentId: ALIA_GEMIE_ID },
    });

    expect(response.status).toBe(200);
    expect(state.update).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        actorMode: 'fixed',
        fixedAgentId: ALIA_GEMIE_ID,
        eligibleAgentIds: [],
      }),
    );
  });
});
