import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { agentWorkRevocations } from '../db/schema/agent-work.js';
import { log } from './logger.js';
/** Durable own-task authority binds the requester once; workers store only its id. */
import { oxy } from './oxy.js';

const TASK_LIFETIME_MS = 365 * 24 * 60 * 60_000;
function agency() {
  return oxy.agency;
}

export async function createOxyTask(input: {
  accessToken: string;
  effectiveAccountId: string;
  actorAccountId?: string;
  actor?:
    | { type: 'alia'; ownerAccountId: string }
    | { type: 'agent'; accountId: string }
    | { type: 'requester'; accountId: string };
  origin: { kind: 'request' | 'goal' | 'automation'; id: string };
}): Promise<string> {
  const actor =
    input.actor ??
    (input.actorAccountId
      ? { type: 'agent' as const, accountId: input.actorAccountId }
      : undefined);
  if (!actor) throw new Error('Oxy task requires its originating actor');
  const task = await agency().createTask(
    {
      origin: input.origin,
      actor,
      effectiveAccountId: input.effectiveAccountId,
      expiresAt: new Date(
        Date.now() + (input.origin.kind === 'request' ? 10 * 60_000 : TASK_LIFETIME_MS),
      ).toISOString(),
    },
    { requesterToken: input.accessToken },
  );
  if (!task.requesterAccountId || task.effectiveAccountId !== input.effectiveAccountId) {
    await agency().revokeTask(task.id);
    throw new Error('Oxy task requester does not match the originating account');
  }
  return task.id;
}

export async function revokeOxyTask(taskId: string): Promise<void> {
  await agency().revokeTask(taskId);
}

/**
 * Whether a task is a STANDING one: held by a binding that outlives any session run under it — a
 * gemie's work authority, a connected account, a system bot's link, or a gemie bot's person
 * (ADR 0037, amendment). Sessions borrow these (a channel turn, the follow-up it scheduled); ending
 * a session never revokes them, only removing the binding does.
 */
export function heldByStandingBinding(taskId: SQL | string): SQL {
  return sql`(exists (select 1 from agent_work_authorities a where a.oxy_task_id = ${taskId})
    or exists (select 1 from connected_accounts c where c.oxy_task_id = ${taskId})
    or exists (select 1 from bot_users u where u.oxy_task_id = ${taskId})
    or exists (select 1 from bots b where b.oxy_task_id = ${taskId}))`;
}

/** Revoke a session's own task, unless a standing binding holds it. */
export async function revokeSessionTask(taskId: string): Promise<void> {
  const rows = await getDb().execute<{ held: boolean }>(
    sql`select ${heldByStandingBinding(taskId)} as held`,
  );
  if (rows[0]?.held) return;
  await revokeOxyTask(taskId);
}

/**
 * Revoke a task a binding released, now or, when Oxy cannot be reached, from the durable outbox
 * the work dispatcher drains (`agent_work_revocations`).
 */
export async function revokeReleasedTask(taskId: string | null): Promise<void> {
  if (!taskId) return;
  try {
    await revokeOxyTask(taskId);
  } catch (err: unknown) {
    log.agents.warn({ err }, 'A released Oxy task will be revoked later');
    await getDb().insert(agentWorkRevocations).values({ oxyTaskId: taskId }).onConflictDoNothing();
  }
}

/** Terminal roots retry retirement durably; child completion never revokes its parent. */
export async function retireFinishedOxyTasks(): Promise<void> {
  const rows = await getDb()
    .select({ id: agentSessions.id, taskId: agentSessions.oxyTaskId })
    .from(agentSessions)
    .where(
      and(
        isNotNull(agentSessions.oxyTaskId),
        isNull(agentSessions.oxyTaskRetiredAt),
        isNull(agentSessions.parentSessionId),
        sql`not ${heldByStandingBinding(sql`${agentSessions.oxyTaskId}`)}`,
        sql`not exists (select 1 from agent_work_items w where w.oxy_task_id = ${agentSessions.oxyTaskId} and w.status in ('pending', 'running'))`,
        inArray(agentSessions.status, ['completed', 'cancelled', 'failed']),
      ),
    )
    .limit(100);
  for (const row of rows) {
    if (!row.taskId) continue;
    try {
      await revokeOxyTask(row.taskId);
      await getDb()
        .update(agentSessions)
        .set({ oxyTaskRetiredAt: new Date() })
        .where(eq(agentSessions.id, row.id));
    } catch (err) {
      log.agents.warn({ err, sessionId: row.id }, 'Oxy task retirement will retry');
    }
  }
}
