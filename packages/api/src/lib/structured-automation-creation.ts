import { uuidv7 } from '@oxy.so/db';
import { z } from 'zod';
import { findAgentById } from '../db/agents/agentRepository.js';
import { ALIA_GEMIE_ID } from '../domain/alia-gemie.js';
import type { AgentTaskAuthority } from '../domain/agent.js';
import {
  countEnabledAutomationDefinitions,
  createAutomationDefinition,
  updateAutomationDefinition,
  type AutomationDefinitionRecord,
} from '../db/automation/automationDefinitionRepository.js';
import { getDb } from '../db/index.js';
import { watchConfigOf, WATCH_INPUT_KEY } from './alia-watch.js';
import {
  loadAutomationActorCandidates,
  planAutomationStages,
  uniqueAutomationResources,
  type AutomationActionPlanInput,
} from './automation-coordination.js';
import { automationExecutionPolicyError } from './automation-execution-policy.js';
import { mayRunForAutomationOwner } from './automation-actors.js';
import { log } from './logger.js';
import { automationReceipt } from './structured-automation.js';
import {
  automationScheduleError,
  automationScheduleTooFrequent,
  reloadAutomationSchedule,
} from './trigger-engine.js';

const automationResourceSchema = z
  .object({
    appId: z.string().min(1).describe('Oxy app id, e.g. inbox'),
    effectiveAccountId: z.string().min(1).describe('Owning Oxy account id'),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1),
  })
  .strict();

const automationLimitSchema = z
  .object({
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  })
  .strict();

const automationLimitsSchema = z.array(automationLimitSchema).superRefine((limits, context) => {
  const keys = new Set<string>();
  limits.forEach((limit, index) => {
    if (keys.has(limit.key)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'key'],
        message: 'Limit keys must be unique',
      });
    }
    keys.add(limit.key);
  });
});

const automationActionLimitSchema = z
  .object({
    key: z.string().min(1),
    value: z.union([z.number(), z.boolean()]),
  })
  .strict();

const automationActionSchema = z
  .object({
    resource: automationResourceSchema,
    tool: z.string().min(1).describe('Exact stable tool name from the app capability catalogue'),
    input: z.record(z.string(), z.unknown()).default({}),
    limits: z.array(automationActionLimitSchema).default([]),
  })
  .strict();

export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z
    .object({
      type: z.literal('event'),
      appId: z.string().min(1),
      eventType: z.string().min(1),
      resource: automationResourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule'),
      cron: z.string().min(1).describe('Five-field cron expression'),
      timezone: z.string().min(1).describe('IANA timezone, such as Europe/Madrid'),
    })
    .strict(),
]);

const automationActorSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), agentId: z.string().min(1) }).strict(),
  z
    .object({
      mode: z.literal('automatic'),
      eligibleAgentIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

export const createAutomationSchema = z
  .object({
    objective: z.string().trim().min(1).describe('What the automation must accomplish'),
    trigger: automationTriggerSchema,
    // A task that names no gemie is Alia's (ADR 0034 §2, §4).
    actorSelection: automationActorSelectionSchema
      .default({ mode: 'fixed', agentId: ALIA_GEMIE_ID })
      .describe('Omit for Alia; an agent only if the user asked for one of theirs'),
    executionMode: z
      .enum(['observe', 'execute'])
      .default('observe')
      .describe('Use execute only when the user explicitly asked for real actions'),
    actions: z
      .array(automationActionSchema)
      .default([])
      .describe('Ordered connected-app effects; empty for reminders, research and replies'),
    inputs: z.record(z.string(), z.unknown()).default({}),
    resources: z.array(automationResourceSchema).default([]),
    dataFlow: z
      .object({
        sources: z.array(automationResourceSchema),
        destinations: z.array(automationResourceSchema),
      })
      .strict(),
    maximumAutonomy: z.enum(['read_only', 'draft', 'execute_on_request', 'autonomous']),
    limits: automationLimitsSchema.default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = z
  .object({
    objective: createAutomationSchema.shape.objective.optional(),
    instructions: z.string().trim().min(1).optional(),
    trigger: automationTriggerSchema.optional(),
    actorSelection: automationActorSelectionSchema.optional(),
    resources: z.array(automationResourceSchema).optional(),
    dataFlow: createAutomationSchema.shape.dataFlow.optional(),
    maximumAutonomy: createAutomationSchema.shape.maximumAutonomy.optional(),
    limits: automationLimitsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one editable field is required',
  });

export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

type AutomationRecord = Awaited<ReturnType<typeof createAutomationDefinition>>;

/**
 * Enabled automations one person may have. Each is a model run billed to them whenever it fires, and an
 * agent can create them on the person's behalf, so the count is a bound on how much can be scheduled
 * by mistake or by a prompt-injected agent. One-off runs (follow-ups, heartbeats) disable themselves
 * when they fire and stop counting.
 */
export const MAX_ENABLED_AUTOMATIONS_PER_OWNER = 100;

export class AutomationCreationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 409 | 503,
    readonly context: { automationId?: string; stopped?: boolean } = {},
  ) {
    super(code);
    this.name = 'AutomationCreationError';
  }
}

async function ownedAutomationAgents(ownerAccountId: string, agentIds: readonly string[]) {
  const agents = await Promise.all(agentIds.map((agentId) => findAgentById(getDb(), agentId)));
  const may = await Promise.all(
    agents.map((agent) =>
      agent === null ? false : mayRunForAutomationOwner(agent, ownerAccountId),
    ),
  );
  if (
    !agents.every(
      (agent, index) => agent !== null && may[index] === true && agent.id === agentIds[index],
    )
  )
    return null;
  return agents.filter((agent): agent is NonNullable<typeof agent> => agent !== null);
}

/**
 * Whether the selected agents, as candidates, cover the source resources and every declared action
 * in a deterministic plan. Checked when the task is saved and again at every dispatch; the run's
 * calls are authorized one by one when they are made (oxy ADR 0066), so nothing is provisioned.
 */
async function actorsCoverActions(input: {
  ownerAccountId: string;
  agents: NonNullable<Awaited<ReturnType<typeof findAgentById>>>[];
  actions: readonly AutomationActionPlanInput[];
  sourceResources: CreateAutomationInput['dataFlow']['sources'];
  requiredAutonomy: CreateAutomationInput['maximumAutonomy'];
}): Promise<boolean> {
  const candidates = await loadAutomationActorCandidates(
    input.ownerAccountId,
    input.agents,
    input.requiredAutonomy,
  );
  return (
    planAutomationStages({
      candidates,
      sourceResources: input.sourceResources,
      actions: input.actions,
      requiredAutonomy: input.requiredAutonomy,
    }) !== null
  );
}

export async function refreshAutomationSchedule(automationId: string): Promise<void> {
  try {
    await reloadAutomationSchedule(automationId);
  } catch (error: unknown) {
    // Persistence is authoritative; the elected scheduler reconciles every 30 seconds.
    log.triggers.warn({ err: error, automationId }, 'Immediate automation schedule refresh failed');
  }
}

function sameResource(
  left: z.infer<typeof automationResourceSchema>,
  right: z.infer<typeof automationResourceSchema>,
): boolean {
  return (
    left.appId === right.appId &&
    left.effectiveAccountId === right.effectiveAccountId &&
    left.resourceType === right.resourceType &&
    left.resourceId === right.resourceId
  );
}

function actionKey(action: CreateAutomationInput['actions'][number]): string {
  return JSON.stringify([
    action.resource.appId,
    action.resource.effectiveAccountId,
    action.resource.resourceType,
    action.resource.resourceId,
    action.tool,
  ]);
}

/** The gemies a selection names. */
function selectedAgentIds(selection: CreateAutomationInput['actorSelection']): string[] {
  return selection.mode === 'fixed' ? [selection.agentId] : selection.eligibleAgentIds;
}

/**
 * Whether the task runs under standing authority: exactly one gemie, named `fixed`, whose
 * `taskAuthority` is `standing` (Alia). Such a gemie runs a task herself on `alia-tasks` and is never
 * one candidate among several, so an `automatic` selection naming one is refused, and so is a watch
 * — the cheap tick that only wakes a standing-authority run — on any other gemie.
 */
function runsUnderStandingAuthority(
  definition: CreateAutomationInput,
  agents: readonly { readonly taskAuthority: AgentTaskAuthority }[],
): boolean {
  const standing = agents.some((agent) => agent.taskAuthority === 'standing');
  if (standing && definition.actorSelection.mode !== 'fixed') {
    throw new AutomationCreationError('standing_gemie_requires_fixed_selection', 400);
  }
  if (definition.inputs[WATCH_INPUT_KEY] !== undefined && !standing) {
    throw new AutomationCreationError('watch_requires_alia', 400);
  }
  return standing;
}

function validateDefinition(definition: CreateAutomationInput): void {
  const executionPolicyError = automationExecutionPolicyError({
    enabled: definition.enabled,
    executionMode: definition.executionMode,
    maximumAutonomy: definition.maximumAutonomy,
    triggerType: definition.trigger.type,
  });
  if (executionPolicyError) throw new AutomationCreationError(executionPolicyError, 400);
  if (definition.inputs[WATCH_INPUT_KEY] !== undefined) {
    if (!watchConfigOf(definition.inputs)) throw new AutomationCreationError('invalid_watch', 400);
    if (definition.trigger.type !== 'schedule') {
      throw new AutomationCreationError('watch_requires_schedule', 400);
    }
    if (definition.actions.length > 0) {
      throw new AutomationCreationError('watch_cannot_declare_connected_actions', 400);
    }
  }
  if (definition.trigger.type === 'event' && definition.dataFlow.sources.length === 0) {
    throw new AutomationCreationError('event_automation_requires_explicit_data_source', 400);
  }
  if (definition.actions.length === 0) {
    if (definition.trigger.type === 'event') {
      throw new AutomationCreationError('event_automation_requires_connected_action', 400);
    }
    if (definition.actorSelection.mode === 'automatic') {
      throw new AutomationCreationError('assistant_task_requires_responsible_agent', 400);
    }
    if (
      definition.resources.length > 0 ||
      definition.dataFlow.sources.length > 0 ||
      definition.dataFlow.destinations.length > 0
    ) {
      throw new AutomationCreationError('assistant_task_cannot_declare_connected_resources', 400);
    }
    if (definition.inputs.runOnce !== undefined && definition.inputs.runOnce !== true) {
      throw new AutomationCreationError('assistant_task_run_once_must_be_true', 400);
    }
  }
  if (definition.trigger.type === 'schedule') {
    const scheduleError = automationScheduleError(
      definition.trigger.cron,
      definition.trigger.timezone,
    );
    if (scheduleError) throw new AutomationCreationError(scheduleError, 400);
    if (automationScheduleTooFrequent(definition.trigger.cron, definition.trigger.timezone)) {
      throw new AutomationCreationError('automation_schedule_too_frequent', 400);
    }
  }
  if (
    definition.actions.some(
      (action) => !definition.resources.some((resource) => sameResource(resource, action.resource)),
    )
  ) {
    throw new AutomationCreationError('automation_action_resource_not_declared', 400);
  }
  if (new Set(definition.actions.map(actionKey)).size !== definition.actions.length) {
    throw new AutomationCreationError('duplicate_automation_action', 400);
  }
  if (
    definition.actions.some(
      (action) => new Set(action.limits.map((limit) => limit.key)).size !== action.limits.length,
    )
  ) {
    throw new AutomationCreationError('duplicate_automation_action_limit', 400);
  }
}

function editableDefinition(
  existing: AutomationDefinitionRecord,
  patch: UpdateAutomationInput,
): CreateAutomationInput {
  const merged = createAutomationSchema.safeParse({
    objective: patch.objective ?? existing.objective,
    trigger: patch.trigger ?? existing.trigger,
    actorSelection: patch.actorSelection ?? existing.actorSelection,
    executionMode: existing.executionMode,
    actions: existing.actions.map((action) => ({
      resource: action.resource,
      tool: action.tool,
      input: action.input,
      limits: action.limits,
    })),
    inputs:
      patch.instructions === undefined
        ? existing.inputs
        : { ...existing.inputs, instructions: patch.instructions },
    resources: patch.resources ?? existing.resources,
    dataFlow: patch.dataFlow ?? existing.dataFlow,
    maximumAutonomy: patch.maximumAutonomy ?? existing.maximumAutonomy,
    limits: patch.limits ?? existing.limits,
    enabled: patch.enabled ?? existing.enabled,
  });
  if (!merged.success) {
    throw new AutomationCreationError('invalid_automation_patch', 400);
  }
  return merged.data;
}

/**
 * Update one structured definition without changing its exact action ids. The edit commits only
 * against the version the caller read (`expectedUpdatedAt`), so a stale editor never overwrites a
 * concurrent change.
 */
export async function updateStructuredAutomation(input: {
  ownerAccountId: string;
  existing: AutomationDefinitionRecord;
  patch: UpdateAutomationInput;
}) {
  const definition = editableDefinition(input.existing, input.patch);
  const executionPolicyError = automationExecutionPolicyError({
    enabled: definition.enabled,
    executionMode: definition.executionMode,
    maximumAutonomy: definition.maximumAutonomy,
    triggerType: definition.trigger.type,
  });
  if (executionPolicyError) throw new AutomationCreationError(executionPolicyError, 409);
  validateDefinition(definition);
  const selection = definition.actorSelection;
  const agentIds = selectedAgentIds(selection);
  if (new Set(agentIds).size !== agentIds.length) {
    throw new AutomationCreationError('duplicate_automation_agent', 400);
  }
  const agents = await ownedAutomationAgents(input.ownerAccountId, agentIds);
  if (!agents) throw new AutomationCreationError('automation_agent_not_owned', 403);

  const sourceResources = uniqueAutomationResources([
    ...(definition.trigger.type === 'event' && definition.trigger.resource
      ? [definition.trigger.resource]
      : []),
    ...definition.dataFlow.sources,
  ]);
  const isAlia = runsUnderStandingAuthority(definition, agents);
  if (
    !isAlia &&
    definition.executionMode === 'execute' &&
    definition.enabled &&
    definition.actions.length > 0 &&
    !(await actorsCoverActions({
      ownerAccountId: input.ownerAccountId,
      agents,
      actions: input.existing.actions,
      sourceResources,
      requiredAutonomy: definition.maximumAutonomy,
    }))
  ) {
    throw new AutomationCreationError('automation_actor_coverage_missing', 403);
  }

  const trigger = definition.trigger;
  let automation: AutomationDefinitionRecord | null;
  try {
    automation = await updateAutomationDefinition(getDb(), {
      id: input.existing.id,
      ownerAccountId: input.ownerAccountId,
      expectedUpdatedAt: input.existing.updatedAt,
      objective: definition.objective,
      triggerKind: trigger.type,
      ...(trigger.type === 'event'
        ? {
            eventAppId: trigger.appId,
            eventType: trigger.eventType,
            eventResource: trigger.resource,
          }
        : {}),
      ...(trigger.type === 'schedule'
        ? {
            scheduleCron: trigger.cron,
            scheduleTimezone: trigger.timezone,
          }
        : {}),
      actorMode: selection.mode,
      fixedAgentId: selection.mode === 'fixed' ? selection.agentId : undefined,
      eligibleAgentIds: selection.mode === 'automatic' ? selection.eligibleAgentIds : [],
      inputs: definition.inputs,
      resources: definition.resources,
      dataFlow: definition.dataFlow,
      maximumAutonomy: definition.maximumAutonomy,
      limits: definition.limits,
      enabled: definition.enabled,
    });
  } catch (error: unknown) {
    log.triggers.error(
      { err: error, automationId: input.existing.id },
      'Could not persist updated automation',
    );
    throw new AutomationCreationError('automation_store_unavailable', 503, {
      automationId: input.existing.id,
    });
  }
  if (!automation) {
    throw new AutomationCreationError('automation_concurrent_update', 409, {
      automationId: input.existing.id,
    });
  }

  await refreshAutomationSchedule(automation.id);
  return { automation, receipt: automationReceipt(automation) };
}

/**
 * The single creation path for HTTP and conversational requests. Nothing is provisioned at Oxy:
 * each run's calls are authorized when they are made, on Gemies' own first-party authority (oxy
 * ADR 0066), within the run's declared scope.
 */
export async function createStructuredAutomation(input: {
  ownerAccountId: string;
  definition: CreateAutomationInput;
}) {
  validateDefinition(input.definition);
  if (
    input.definition.enabled &&
    (await countEnabledAutomationDefinitions(getDb(), input.ownerAccountId)) >=
      MAX_ENABLED_AUTOMATIONS_PER_OWNER
  ) {
    throw new AutomationCreationError('too_many_automations', 409);
  }
  const selection = input.definition.actorSelection;
  const agentIds = selectedAgentIds(selection);
  if (new Set(agentIds).size !== agentIds.length) {
    throw new AutomationCreationError('duplicate_automation_agent', 400);
  }
  const agents = await ownedAutomationAgents(input.ownerAccountId, agentIds);
  if (!agents) throw new AutomationCreationError('automation_agent_not_owned', 403);

  const automationId = uuidv7();
  const actions = input.definition.actions.map((action) => ({ id: uuidv7(), ...action }));
  const trigger = input.definition.trigger;
  const sourceResources = uniqueAutomationResources([
    ...(trigger.type === 'event' && trigger.resource ? [trigger.resource] : []),
    ...input.definition.dataFlow.sources,
  ]);
  const isAlia = runsUnderStandingAuthority(input.definition, agents);
  if (
    !isAlia &&
    input.definition.executionMode === 'execute' &&
    input.definition.enabled &&
    actions.length > 0 &&
    !(await actorsCoverActions({
      ownerAccountId: input.ownerAccountId,
      agents,
      actions,
      sourceResources,
      requiredAutonomy: input.definition.maximumAutonomy,
    }))
  ) {
    throw new AutomationCreationError('automation_actor_coverage_missing', 403);
  }

  let automation: AutomationRecord;
  try {
    automation = await createAutomationDefinition(getDb(), {
      id: automationId,
      ownerAccountId: input.ownerAccountId,
      objective: input.definition.objective,
      triggerKind: trigger.type,
      ...(trigger.type === 'event'
        ? {
            eventAppId: trigger.appId,
            eventType: trigger.eventType,
            eventResource: trigger.resource,
          }
        : {}),
      ...(trigger.type === 'schedule'
        ? {
            scheduleCron: trigger.cron,
            scheduleTimezone: trigger.timezone,
          }
        : {}),
      actorMode: selection.mode,
      fixedAgentId: selection.mode === 'fixed' ? selection.agentId : undefined,
      eligibleAgentIds: selection.mode === 'automatic' ? selection.eligibleAgentIds : [],
      executionMode: input.definition.executionMode,
      actions,
      inputs: input.definition.inputs,
      resources: input.definition.resources,
      dataFlow: input.definition.dataFlow,
      maximumAutonomy: input.definition.maximumAutonomy,
      limits: input.definition.limits,
      enabled: input.definition.enabled,
    });
  } catch (error: unknown) {
    log.triggers.error(
      { err: error, ownerAccountId: input.ownerAccountId },
      'Could not persist automation definition',
    );
    throw new AutomationCreationError('automation_store_unavailable', 503);
  }

  await refreshAutomationSchedule(automation.id);
  return { automation, receipt: automationReceipt(automation) };
}
