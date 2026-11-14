import cronParser from 'cron-parser';
import { automationDefinitions, automationRuns, automationActions } from '../../db/schema/agency';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/index';
import { agents } from '../../db/schema/agents';
import { agentGoals } from '../../db/schema/agent-runtime';
import { agentSessions } from '../../db/schema/agent-sessions';
import { agentWorkItems } from '../../db/schema/agent-work';
import { lockAgentWork, pendingWork } from '../../db/agents/agentWorkRepository';
import { findAgentById } from '../../db/agents/agentRepository';
import { createAgentSession } from '../../db/agents/agentSessionRepository';
import { withAgentAdmission } from '../../db/agents/agentRuntimeRepository';
import { prepareBackgroundCreditReservation } from '../product-credit-access';
import { getOrCreateUserCredits } from '../user-credits-helpers';
import { enqueueAgentSession } from '../task-queue';
import { agentOpensOn } from '../agent-availability';
import { gemieOxyAccountId } from '../gemie-oxy-actor';
import { log } from '../logger';
import { agentHirePrice } from './session-handoff';
import { deliverPendingAgentWorkResults } from './work-delivery';

/**
 * The owner turned their gemie's attention on (or opened it): adopt its legacy one-shot wake
 * schedules. Its work needs nothing else: it runs for the owner on Gemies' own first-party
 * authority (oxy ADR 0066), while the gemie is active and its attention is on.
 */
export async function establishAgentWork(agentId: string, ownerAccountId: string) {
  const db = getDb();
  const agent = await findAgentById(db, agentId);
  if (
    !agent ||
    agent.ownerOxyAccountId !== ownerAccountId ||
    agent.status !== 'active' ||
    !agent.scheduleInterval
  )
    return;
  // A gemie with no Oxy account (ADR 0036) is nobody at Oxy, so it has no background work and
  // works only when its owner talks to it.
  if (gemieOxyAccountId(agent) === null) return;
  await migrateAgentWakeSchedules(agentId, ownerAccountId);
}

/** Event batches and follow-ups use the existing durable runner, billing and tool policy. */
export async function dispatchAgentWork(now = new Date()): Promise<number> {
  const db = getDb();
  // Reconcile after a worker or notification process died. A terminal execution is never replayed.
  await db.execute(sql`update agent_work_items w set status = s.status, updated_at = now()
    from agent_sessions s where w.session_id = s.id and w.status = 'running'
    and s.status in ('completed', 'failed', 'cancelled')`);
  await deliverPendingAgentWorkResults();
  let started = 0;
  for (const work of await pendingWork(db, now)) {
    try {
      if (work.attempts >= 12 || now.getTime() - work.dueAt.getTime() > 3 * 86400000) {
        await db
          .update(agentWorkItems)
          .set({
            status: 'failed',
            failure: work.attempts >= 12 ? 'temporarily_unavailable' : 'expired',
            updatedAt: now,
          })
          .where(and(eq(agentWorkItems.id, work.id), eq(agentWorkItems.status, 'pending')));
        continue;
      }

      const agent = await findAgentById(db, work.agentId);
      if (
        !agent ||
        (!work.sourceSessionId && agent.ownerOxyAccountId !== work.ownerAccountId) ||
        agent.status !== 'active' ||
        (work.kind === 'heartbeat' && !agent.scheduleInterval)
      )
        continue;
      // Gemies acts for the owner on its own first-party authority (oxy ADR 0066); the agent's
      // confinement stays live.
      if ((await agentOpensOn(agent, null)) !== 'reachable')
        throw new Error('Agent availability could not authorize this surface');
      await getOrCreateUserCredits(work.ownerAccountId);
      const reserve = await prepareBackgroundCreditReservation(
        work.ownerAccountId,
        agentHirePrice(agent),
      );
      const admission = await withAgentAdmission(
        db,
        { agentId: work.agentId, oxyUserId: work.ownerAccountId },
        1,
        async (tx) => {
          await lockAgentWork(tx, work.agentId);
          const [fresh] = await tx
            .select()
            .from(agentWorkItems)
            .where(eq(agentWorkItems.id, work.id))
            .for('update');
          if (!fresh || fresh.status !== 'pending' || fresh.dueAt > now) return null;
          const [live] = await tx.select().from(agents).where(eq(agents.id, work.agentId));
          if (
            !live ||
            live.status !== 'active' ||
            (!work.sourceSessionId && live.ownerOxyAccountId !== work.ownerAccountId) ||
            (work.kind === 'heartbeat' && !live.scheduleInterval)
          )
            return null;
          const source = work.sourceSessionId
            ? (
                await tx
                  .select()
                  .from(agentSessions)
                  .where(eq(agentSessions.id, work.sourceSessionId))
              )[0]
            : null;
          if (
            work.sourceSessionId &&
            (!source || source.agentId !== work.agentId || source.oxyUserId !== work.ownerAccountId)
          )
            return null;
          // A gemie with no Oxy account (ADR 0036) has no background work.
          if (live.identity !== 'oxy') {
            await tx
              .update(agentWorkItems)
              .set({ status: 'failed', failure: 'no_background_work', updatedAt: now })
              .where(eq(agentWorkItems.id, work.id));
            return null;
          }
          if (source && ['queued', 'running'].includes(source.status)) return null;
          const [used] = await tx
            .select({
              steps: sql<number>`coalesce(sum(${agentSessions.statsTotalSteps}), 0)::int`,
              tokens: sql<number>`coalesce(sum(${agentSessions.statsTotalTokens}), 0)::int`,
            })
            .from(agentSessions)
            .where(
              sql`${agentSessions.id} = ${work.rootId} or ${agentSessions.id} in (select session_id from agent_work_items where root_id = ${work.rootId})`,
            );
          const maxSteps = 50 - (used?.steps ?? 0);
          const maxTokens = 100000 - (used?.tokens ?? 0);
          if (maxSteps <= 0 || maxTokens <= 0 || work.attempts >= 12) {
            await tx
              .update(agentWorkItems)
              .set({ status: 'failed', failure: 'work_limit_reached', updatedAt: now })
              .where(eq(agentWorkItems.id, work.id));
            return null;
          }
          const reservation = await reserve(tx);
          if (!reservation) {
            await tx
              .update(agentWorkItems)
              .set({
                attempts: fresh.attempts + 1,
                failure: 'insufficient_credits',
                dueAt: new Date(now.getTime() + 3600000),
                updatedAt: now,
              })
              .where(eq(agentWorkItems.id, work.id));
            return null;
          }
          const context = source
            ? `\nContinue your earlier work without repeating completed actions. Previous task and results are context:\n${JSON.stringify({ result: source.result?.slice(0, 8000), plan: (source.planItems ?? []).slice(0, 20).map((item) => ({ ...item, text: item.text.slice(0, 300) })) }).replace(/</g, '\\u003c')}`
            : '';
          const goals =
            work.kind === 'heartbeat'
              ? await tx
                  .select({ objective: agentGoals.objective, status: agentGoals.status })
                  .from(agentGoals)
                  .where(
                    and(
                      eq(agentGoals.agentId, work.agentId),
                      eq(agentGoals.oxyUserId, work.ownerAccountId),
                      inArray(agentGoals.status, ['active', 'blocked']),
                    ),
                  )
                  .orderBy(agentGoals.updatedAt)
                  .limit(5)
              : [];
          const currentWork = goals.length
            ? `\nYour unfinished goals (context; do not duplicate their existing runs):\n${JSON.stringify(goals.map((goal) => ({ ...goal, objective: goal.objective.slice(0, 1000) }))).replace(/</g, '\\u003c')}`
            : '';
          const session = await createAgentSession(tx, {
            id: randomUUID(),
            agentId: work.agentId,
            oxyUserId: work.ownerAccountId,
            task: work.objective + context + currentWork,
            status: 'queued',
            ...(source?.threadId ? { threadId: source.threadId } : {}),
            ...(source?.conversationId ? { conversationId: source.conversationId } : {}),
            ...(source?.goalId ? { goalId: source.goalId } : {}),
            workItemId: work.id,
            creditReservation: reservation,
            config: { maxSteps, maxTokens },
          });
          await tx
            .update(agentWorkItems)
            .set({ status: 'running', sessionId: session.id, failure: null, updatedAt: now })
            .where(eq(agentWorkItems.id, work.id));
          return session;
        },
      );
      if (admission.admitted && admission.value) started++;
    } catch (err) {
      log.agents.error({ err, workId: work.id }, 'Agent work admission failed; retrying later');
      await db
        .update(agentWorkItems)
        .set({
          attempts: sql`${agentWorkItems.attempts} + 1`,
          dueAt: new Date(
            now.getTime() + Math.min(3600000, 60000 * 2 ** Math.min(work.attempts, 6)),
          ),
          failure: 'temporarily_unavailable',
          updatedAt: now,
        })
        .where(and(eq(agentWorkItems.id, work.id), eq(agentWorkItems.status, 'pending')));
    }
  }
  // The DB is the outbox: enqueue can fail or the process can die without losing this handoff.
  const queued = await db
    .select({ session: agentSessions })
    .from(agentWorkItems)
    .innerJoin(agentSessions, eq(agentSessions.id, agentWorkItems.sessionId))
    .where(
      and(
        inArray(agentWorkItems.status, ['running', 'cancelled']),
        eq(agentSessions.status, 'queued'),
      ),
    )
    .limit(100);
  for (const { session } of queued) {
    await enqueueAgentSession({
      sessionId: session.id,
      userId: session.oxyUserId,
      agentId: session.agentId,
      agentName: 'Agent',
    }).catch((err) => log.agents.warn({ err, sessionId: session.id }, 'Agent work remains queued'));
  }
  return started;
}

/**
 * Pause or delete: cancel the gemie's work. Turning off attention only (`onlyIfPaused` on a gemie
 * still active) cancels the work its attention started (`initiative`), never a continuation a
 * person asked for (`requested`).
 */
export async function stopAgentWork(agentId: string, onlyIfPaused = false): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await lockAgentWork(tx, agentId);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId));
    if (onlyIfPaused && agent?.status === 'active' && agent.scheduleInterval) return;
    const attentionOnly = onlyIfPaused && agent?.status === 'active';
    await tx
      .update(agentWorkItems)
      .set({ status: 'cancelled', failure: 'paused', updatedAt: new Date() })
      .where(
        and(
          eq(agentWorkItems.agentId, agentId),
          attentionOnly ? eq(agentWorkItems.deliveryMode, 'initiative') : undefined,
          inArray(agentWorkItems.status, ['pending', 'running']),
        ),
      );
  });
}

export async function autonomousWorkMayRun(sessionId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: agentWorkItems.id })
    .from(agentWorkItems)
    .innerJoin(agents, eq(agents.id, agentWorkItems.agentId))
    .where(
      and(
        eq(agentWorkItems.sessionId, sessionId),
        eq(agentWorkItems.status, 'running'),
        eq(agents.status, 'active'),
        sql`(${agentWorkItems.sourceSessionId} is not null or ${agents.ownerOxyAccountId} = ${agentWorkItems.ownerAccountId})`,
        sql`(${agentWorkItems.kind} <> 'heartbeat' or ${agents.scheduleInterval} > 0)`,
      ),
    );
  return Boolean(row);
}

/** Adopt only unexecuted internal one-shots. User automations and historical deliveries stay intact. */
async function migrateAgentWakeSchedules(agentId: string, ownerAccountId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const definitions = await tx
      .select()
      .from(automationDefinitions)
      .where(
        and(
          eq(automationDefinitions.fixedAgentId, agentId),
          eq(automationDefinitions.ownerAccountId, ownerAccountId),
          eq(automationDefinitions.enabled, true),
          eq(automationDefinitions.triggerKind, 'schedule'),
          sql`${automationDefinitions.inputs}->>'origin' in ('agent_heartbeat', 'agent_follow_up')`,
          sql`${automationDefinitions.inputs}->>'runOnce' = 'true'`,
          sql`not exists (select 1 from ${automationActions} where ${automationActions.automationId} = ${automationDefinitions.id})`,
        ),
      )
      .for('update')
      .limit(100);
    for (const definition of definitions) {
      const [run] = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(eq(automationRuns.automationId, definition.id))
        .limit(1);
      if (run || !definition.scheduleCron) continue;
      const dueAt = cronParser
        .parseExpression(definition.scheduleCron, {
          currentDate: definition.createdAt,
          tz: definition.scheduleTimezone ?? 'UTC',
        })
        .next()
        .toDate();
      const id = `legacy-wake:${definition.id}`;
      // The old API allowed at most 90 days ahead. Do not turn a stale annual cron into new authority.
      const expired =
        dueAt.getTime() - definition.createdAt.getTime() > 90 * 86400000 ||
        dueAt.getTime() < Date.now() - 3 * 86400000;
      await tx
        .insert(agentWorkItems)
        .values({
          id,
          rootId: id,
          agentId,
          ownerAccountId,
          kind: 'follow_up',
          objective: definition.objective,
          dueAt,
          status: expired ? 'failed' : 'pending',
          failure: expired ? 'expired' : null,
        })
        .onConflictDoNothing();
      await tx
        .update(automationDefinitions)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(automationDefinitions.id, definition.id));
    }
  });
}
