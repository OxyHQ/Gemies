/**
 * One run of a scheduled task whose responsible actor is Alia.
 *
 * Alia is the default actor of every task; agents are optional. Such a run has
 * no agent session: the dispatcher claims the run with Alia as its actor, holds
 * the owner's credits and queues this job (`alia-task-queue.ts`). Here Alia
 * takes one unattended turn for the owner — the same composition as the
 * service-trigger path in `routes/internal.ts`: the `auto` power level, the
 * one tool assembler with no agent — then settles the hold against the tokens
 * spent, closes the run and posts the answer into the task's own conversation
 * (`postAliaMessage`).
 *
 * Authority: Alia acts for the owner in their Oxy apps on Gemies' own
 * first-party authority (oxy ADR 0066), with no session or task. The run's
 * scope ({@link aliaRunScope}) is built here, at run time: every read tool of
 * their apps, repeatable, and each declared connected action once, correlated
 * with its run step and carrying its declared limits. Each call is authorized
 * when it is made. The person stops it by disabling or deleting the task.
 *
 * Watch runs (`lib/alia-watch.ts`) carry the observed change in their trigger
 * and may conclude it is not worth telling the person: they reply
 * {@link WATCH_NOTHING_TO_REPORT} and nothing is posted.
 *
 * Failure: a job that throws is retried by the queue with its hold intact. On
 * the last attempt the hold is refunded, the run is marked failed and the
 * person is told — in the task's conversation, or by notification if even
 * that is out of reach. A run whose worker vanished is failed and refunded by
 * `alia-task-reaper.ts` once its lease lapses; every settlement here is
 * conditional on the run still being open, so the two never both refund.
 */

import { ALIA_GEMIE_ID } from '../domain/alia-gemie.js';
import { stepCountIs } from 'ai';
import { generateAnswered } from './chat/tool-synthesis.js';
import type { User as OxyUser } from '@oxy.so/core';
import { getDb } from '../db/index.js';
import { findAgentById } from '../db/agents/agentRepository.js';
import { attachAgentIdentity, type HydratedAgent } from './agent-identity.js';
import {
  automationRunIsOpen,
  findAutomationDefinitionById,
  findAutomationRunById,
  listAutomationRunActionSteps,
  listAutomationRunSteps,
  markAliaAutomationRun,
  markAutomationActionStep,
} from '../db/automation/automationDefinitionRepository.js';
import { findUserMemory, type UserMemoryProfile } from '../db/memory/userMemoryRepository.js';
import { oxy } from './oxy.js';
import { postAliaMessage } from './agent/alia-outreach.js';
import type { AliaTaskJobData } from './alia-task-queue.js';
import { renderAutomationStageTask } from './automation-stage-task.js';
import { WATCH_INPUT_KEY } from './alia-watch.js';
import { getAIModel, resolveDefaultModel } from './chat-core.js';
import { finalizeCredits, safeRefund, type CreditUsage } from './credits-manager.js';
import { servedModelId, servedReferenceOf } from './models/power-levels.js';
import { buildIdentityGuard } from './identity-guard.js';
import { AliaError, AliaErrorCode } from './errors/error-codes.js';
import { log } from './logger.js';
import { sendNotification } from './notification-service.js';
import { ToolPipeline } from './tool-pipeline.js';
import {
  listOxyAccountReadTools,
  oxyRunScopeKey,
  type OxyRunScopeEntry,
} from './tools/oxy-services.js';
import { userContextBlock } from './user-context.js';

/** Model steps one run may take: room to search, read and answer, not to wander. */
export const ALIA_TASK_MAX_STEPS = 10;

/** The longest one run's model turn may take before it is aborted. */
const ALIA_TASK_TIMEOUT_MS = 10 * 60_000;
/**
 * How long a started run is presumed to have a live worker. Longer than
 * {@link ALIA_TASK_TIMEOUT_MS} plus settlement, so only a vanished worker
 * lets it lapse.
 */
export const ALIA_TASK_LEASE_MS = 15 * 60_000;

/** A watch run's whole reply when the change is not worth telling anyone. */
export const WATCH_NOTHING_TO_REPORT = 'NOTHING_TO_REPORT';

const WATCH_GUIDELINES = `

## This run was started by a watch

The source this task watches changed; \`trigger.watch\` below says what changed. Decide whether it is something the person asked to hear about.
- If it is, tell them what is new, concisely, with links.
- If it is not (noise, a reshuffle, nothing relevant), reply exactly ${WATCH_NOTHING_TO_REPORT} and nothing else.`;

/**
 * What one Alia run may call: every read tool of the owner's Oxy apps at their account root,
 * repeatable, and each connected action the task declares whose step belongs to this run, once,
 * with its step and limits. A declared action wins over the read of the same tool. Reads the
 * catalogue cannot list right now are left out (the run still does what it can); never an action.
 * A watch reads only the open web (`reads: false`): least authority.
 */
export async function aliaRunScope(
  ownerAccountId: string,
  runId: string,
  options: { reads: boolean } = { reads: true },
): Promise<Record<string, OxyRunScopeEntry>> {
  const [reads, steps] = await Promise.all([
    options.reads
      ? listOxyAccountReadTools(ownerAccountId).catch((err: unknown) => {
          log.agents.warn({ err, runId }, 'Could not list the read tools of an Alia task run');
          return [];
        })
      : [],
    listAutomationRunActionSteps(getDb(), runId),
  ]);
  const scope: Record<string, OxyRunScopeEntry> = {};
  for (const read of reads) scope[oxyRunScopeKey(read.resource, read.tool)] = { repeatable: true };
  for (const step of steps) {
    scope[oxyRunScopeKey(step.resource, step.tool)] = {
      stepId: step.stepId,
      repeatable: false,
      limits: step.limits,
    };
  }
  return scope;
}

function isWatchRun(input: Record<string, unknown>): boolean {
  const trigger = input.trigger;
  return typeof trigger === 'object' && trigger !== null && 'watch' in trigger;
}

const FAILURE_MESSAGE = "I couldn't complete this scheduled task this time.";

function buildAliaTaskSystemPrompt(
  oxyUser: OxyUser | null,
  memory: UserMemoryProfile | null,
): string {
  // Names nobody: `buildIdentityGuard` is prepended above this and owns that.
  const prompt = `You are running a scheduled task the person asked you to do, unattended. They are not in this conversation right now; they will read your answer later, in a conversation dedicated to this task.

## Guidelines

- Do the task now with the tools you have, then reply with the result for them: what you found or did, concisely.
- If there is nothing new or relevant to report, say so in one sentence.
- Do not ask questions you need answered to continue — nobody will answer during this run. State any assumption you made.
- Use the person's preferred language if known.`;
  return `${userContextBlock(oxyUser, memory)}${prompt}`;
}

async function loadPersonContext(
  userId: string,
): Promise<{ oxyUser: OxyUser | null; memory: UserMemoryProfile | null }> {
  const [memory, oxyUser] = await Promise.all([
    findUserMemory(getDb(), userId)
      .then((found) => found ?? null)
      .catch((err: unknown) => {
        log.agents.warn({ err }, 'Could not load memory for an Alia task');
        return null;
      }),
    (oxy.users.get(userId) as Promise<OxyUser>).catch((err: unknown) => {
      log.agents.info({ err }, 'Could not fetch the Oxy profile for an Alia task');
      return null;
    }),
  ]);
  return { oxyUser, memory };
}

/**
 * The gemie the dispatcher recorded on a standing-lane run, which must still be one whose work runs
 * under standing authority; `null` for anything else, which this lane may not drive.
 */
async function loadStandingGemie(agentId: string): Promise<HydratedAgent | null> {
  const row = await findAgentById(getDb(), agentId);
  return row === null || row.taskAuthority !== 'standing' ? null : attachAgentIdentity(row);
}

/**
 * Run one queued Alia task. Returns `skipped` for a run that is not this
 * job's to drive (gone, not Alia's, or already settled); throws for a failure
 * the queue may retry.
 */
export async function runAliaTask(
  data: AliaTaskJobData,
  options: { finalAttempt: boolean },
): Promise<'completed' | 'failed' | 'skipped'> {
  const run = await findAutomationRunById(getDb(), data.runId);
  if (!run || run.selectedActorType !== 'alia') {
    await safeRefund(data.creditReservation, 'Alia task run not found');
    return 'skipped';
  }
  // Stopped by its owner before it ran: nobody else gives its hold back.
  if (run.status === 'cancelled') {
    await safeRefund(data.creditReservation, 'Alia task stopped by its owner');
    return 'skipped';
  }
  if (run.status !== 'planned' && run.status !== 'running') return 'skipped';

  const automation = await findAutomationDefinitionById(getDb(), run.automationId);
  if (!automation || automation.ownerAccountId !== data.userId) {
    if (await markAliaAutomationRun(getDb(), data.runId, 'failed')) {
      await safeRefund(data.creditReservation, 'Alia task definition not found');
    }
    return 'failed';
  }
  // ROLLOUT WINDOW ONLY (ADR 0034): a run the replaced image queued names no gemie until 0136 (post,
  // same release) rewrites it; on this lane that is Alia's.
  const gemie = await loadStandingGemie(run.selectedAgentId ?? ALIA_GEMIE_ID);
  if (gemie === null) {
    if (await markAliaAutomationRun(getDb(), data.runId, 'failed')) {
      await safeRefund(data.creditReservation, 'Standing-authority gemie not found');
    }
    return 'failed';
  }

  let settled = false;
  try {
    const steps = await listAutomationRunSteps(getDb(), data.runId);
    const control = steps.find((step) => step.tool === 'alia.run');
    if (!control) throw new Error('Alia task run has no control step');
    const task = renderAutomationStageTask(control.input);
    const watchRun = isWatchRun(control.input);
    // Also renews the lease on a retry. False: the reaper already closed it, or its owner stopped it.
    if (
      !(await markAliaAutomationRun(getDb(), data.runId, 'running', {
        leaseMs: ALIA_TASK_LEASE_MS,
      }))
    ) {
      settled = true;
      if (await stoppedByOwner(data.runId))
        await safeRefund(data.creditReservation, 'Alia task stopped by its owner');
      return 'skipped';
    }

    const [{ oxyUser, memory }, resolved, runScope] = await Promise.all([
      loadPersonContext(data.userId),
      resolveDefaultModel(),
      aliaRunScope(data.userId, data.runId, {
        reads: automation.inputs[WATCH_INPUT_KEY] === undefined,
      }),
    ]);
    const { tools, routing, appCatalogPrompt } = await ToolPipeline.forUser({
      inputLimits: resolved.catalogue,
      userId: data.userId,
      isDirectSession: false,
      // The gemie acts for the task's owner, who asked for it.
      actsForPerson: true,
      agent: gemie,
      toolsEnabled: true,
      webSearch: true,
      isLocalRuntime: false,
      runId: data.runId,
      oxyAutonomy: automation.maximumAutonomy,
      // Exactly the run's scope; `{}` (none) builds no Oxy tools.
      oxyRunScope: runScope,
      oxyRunIsOpen: () => automationRunIsOpen(getDb(), data.runId),
      onOxyStepStatus: async (stepId, status, auditEventId) => {
        try {
          await markAutomationActionStep(getDb(), stepId, status, auditEventId);
        } catch (err: unknown) {
          log.agents.warn(
            { err, runId: data.runId, stepId, status },
            'Could not record an Alia task step',
          );
        }
      },
    });
    const systemPrompt = `${buildIdentityGuard()}\n\n---\n\n${buildAliaTaskSystemPrompt(oxyUser, memory)}${watchRun ? WATCH_GUIDELINES : ''}`;

    const answered = await generateAnswered({
      model: getAIModel(resolved, 'trigger'),
      messages: [
        { role: 'system', content: systemPrompt + appCatalogPrompt },
        { role: 'user', content: task },
      ],
      tools,
      // Bounds each request to the per-request tool budget (`lib/tool-budget.ts`).
      ...routing,
      // The queue retries the whole run; a retry here would double-spend.
      maxRetries: 0,
      stopWhen: stepCountIs(ALIA_TASK_MAX_STEPS),
      abortSignal: AbortSignal.timeout(ALIA_TASK_TIMEOUT_MS),
    });

    // A run that ended with no words did not answer. It fails typed, before the
    // hold is charged or the run closed: the queue retries it, and on the last
    // attempt the hold is refunded and the person told — never a filler
    // "Task finished." posted as if the task had been done.
    const reply = answered.text.trim();
    if (!reply) {
      throw new AliaError({
        code: AliaErrorCode.EMPTY_RESPONSE,
        message: 'The Alia task run finished without any reply text',
        retryable: true,
        reason: 'provider_unavailable',
      });
    }

    // Every step, not only the last: a run that searched three times spent that.
    const usage: CreditUsage = {
      promptTokens: answered.usage.inputTokens,
      completionTokens: answered.usage.outputTokens,
      totalTokens: answered.usage.totalTokens,
    };
    // Closed first and conditionally: if the reaper failed this run while it
    // ran, it already refunded the hold and told the person.
    const closed = await markAliaAutomationRun(getDb(), data.runId, 'succeeded');
    settled = true;
    if (!closed) {
      log.agents.warn(
        { runId: data.runId },
        'Alia task finished after it was closed; result dropped',
      );
      // Stopped by its owner while it ran: what it spent is settled here, since nobody else will.
      if (await stoppedByOwner(data.runId)) {
        await finalizeCredits(
          data.creditReservation,
          usage,
          servedModelId(resolved.modelId, servedReferenceOf(answered.last)),
        ).catch(() => safeRefund(data.creditReservation, 'Alia task settlement failed'));
      }
      return 'skipped';
    }
    try {
      await finalizeCredits(
        data.creditReservation,
        usage,
        servedModelId(resolved.modelId, servedReferenceOf(answered.last)),
      );
    } catch (err: unknown) {
      log.agents.error({ err, runId: data.runId }, 'Could not settle an Alia task run');
      // Unsettled, therefore refunded: the person is not charged the full hold.
      await safeRefund(data.creditReservation, 'Alia task settlement failed');
    }

    if (
      watchRun &&
      (reply === WATCH_NOTHING_TO_REPORT || reply.startsWith(WATCH_NOTHING_TO_REPORT))
    ) {
      return 'completed';
    }
    try {
      await postAliaMessage({
        oxyUserId: data.userId,
        automationId: automation.id,
        agentId: gemie._id,
        objective: automation.objective,
        conversationId: automation.conversationId,
        content: reply,
      });
    } catch (err: unknown) {
      log.agents.warn({ err, runId: data.runId }, 'Failed to deliver an Alia task result');
    }
    return 'completed';
  } catch (err: unknown) {
    log.agents.error({ err, runId: data.runId }, 'Alia task run failed');
    // Already charged: a retry would run the task, and charge it, again.
    if (settled) return 'failed';
    if (!options.finalAttempt) throw err;
    // Only the caller that closes the run refunds it (see the reaper).
    if (await markAliaAutomationRun(getDb(), data.runId, 'failed')) {
      await safeRefund(data.creditReservation, 'Alia task failed');
      await notifyFailure(data, automation, gemie._id);
    } else if (await stoppedByOwner(data.runId)) {
      await safeRefund(data.creditReservation, 'Alia task stopped by its owner');
    }
    throw err;
  }
}

/** Whether the run's owner stopped it (`cancelOpenAutomationRuns`), rather than it finishing. */
async function stoppedByOwner(runId: string): Promise<boolean> {
  return (await findAutomationRunById(getDb(), runId))?.status === 'cancelled';
}

async function notifyFailure(
  data: AliaTaskJobData,
  automation: NonNullable<Awaited<ReturnType<typeof findAutomationDefinitionById>>>,
  agentId: string,
): Promise<void> {
  try {
    await postAliaMessage({
      oxyUserId: data.userId,
      automationId: automation.id,
      agentId,
      objective: automation.objective,
      conversationId: automation.conversationId,
      content: FAILURE_MESSAGE,
    });
  } catch (err: unknown) {
    log.agents.warn({ err, runId: data.runId }, 'Could not post an Alia task failure');
    await sendNotification({
      userId: data.userId,
      type: 'trigger_result',
      title: `“${automation.objective}” did not run`,
      body: FAILURE_MESSAGE,
      priority: 'high',
      channels: ['in_app', 'push'],
      data: { automationId: automation.id, runId: data.runId, status: 'failed' },
    }).catch((notifyErr: unknown) =>
      log.agents.warn({ err: notifyErr }, 'Could not notify about a failed Alia task'),
    );
  }
}
