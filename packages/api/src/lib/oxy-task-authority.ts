import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { agentWorkRevocations } from '../db/schema/agent-work.js';
import { lapseRefusedChannelTask } from '../db/integrations/channelTaskRepository.js';
import { log } from './logger.js';
/** Durable own-task authority binds the requester once; workers store only its id. */
import { oxy } from './oxy.js';

const TASK_LIFETIME_MS = 365 * 24 * 60 * 60_000;
function agency() {
  return oxy.agency;
}

/** A durable task as Oxy minted it: its id, and when Oxy says it lapses. */
export interface OxyTask {
  readonly id: string;
  readonly expiresAt: Date;
}

export type OxyTaskInput = {
  accessToken: string;
  effectiveAccountId: string;
  actorAccountId?: string;
  actor?:
    | { type: 'alia'; ownerAccountId: string }
    | { type: 'agent'; accountId: string }
    | { type: 'requester'; accountId: string };
  origin: { kind: 'request' | 'goal' | 'automation'; id: string };
};

/**
 * Mint a task with the requester's present session. Its expiry is the one Oxy answers, which may be
 * earlier than the one asked for (Oxy clamps it, `first-party-tasks.md`): a binding that has to be
 * renewed before it lapses stores this one.
 */
export async function mintOxyTask(input: OxyTaskInput): Promise<OxyTask> {
  const actor =
    input.actor ??
    (input.actorAccountId
      ? { type: 'agent' as const, accountId: input.actorAccountId }
      : undefined);
  if (!actor) throw new Error('Oxy task requires its originating actor');
  const requested = new Date(
    Date.now() + (input.origin.kind === 'request' ? 10 * 60_000 : TASK_LIFETIME_MS),
  );
  const task = await agency().createTask(
    {
      origin: input.origin,
      actor,
      effectiveAccountId: input.effectiveAccountId,
      expiresAt: requested.toISOString(),
    },
    { requesterToken: input.accessToken },
  );
  if (!task.requesterAccountId || task.effectiveAccountId !== input.effectiveAccountId) {
    await agency().revokeTask(task.id);
    throw new Error('Oxy task requester does not match the originating account');
  }
  const answered = Date.parse(task.expiresAt);
  return { id: task.id, expiresAt: Number.isFinite(answered) ? new Date(answered) : requested };
}

export async function createOxyTask(input: OxyTaskInput): Promise<string> {
  return (await mintOxyTask(input)).id;
}

/**
 * Whether Oxy refused a task itself — revoked, expired, or no longer honoured for its subjects —
 * rather than the operation asked of it. What Oxy answers then (`firstPartyTaskAuthority.service`).
 */
export function isTaskAuthorityRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? error.status : undefined;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return status === 403 && /task authority is no longer active/i.test(message);
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

/**
 * Mint a task for a standing binding (a channel's, ADR 0037 amendment) and put it in place. `write`
 * stores it only while the binding is still what the caller verified, and answers the task it
 * replaced (or `null` when it changed meanwhile and nothing was written). The new task is revoked
 * when it was not written; the one it replaced is released only after it was, never before: a
 * binding that changed mid-request keeps the task it had, still live, rather than a revoked one.
 */
export async function bindOxyTask(
  input: OxyTaskInput,
  write: (task: OxyTask) => Promise<{ replaced: string | null } | null>,
): Promise<OxyTask | null> {
  const task = await mintOxyTask(input);
  let written: { replaced: string | null } | null;
  try {
    written = await write(task);
  } catch (error: unknown) {
    await revokeReleasedTask(task.id);
    throw error;
  }
  if (!written) {
    await revokeReleasedTask(task.id);
    return null;
  }
  if (written.replaced !== task.id) await revokeReleasedTask(written.replaced);
  return task;
}

/**
 * Oxy refused a task on its own account (`isTaskAuthorityRefusal`): a channel holding it needs its
 * person now, and the channel sweep tells them once (`channel-task-authority.ts`). A task no
 * channel holds changes nothing.
 */
export async function standingTaskRefused(taskId: string): Promise<void> {
  const lapsed = await lapseRefusedChannelTask(getDb(), taskId);
  if (lapsed > 0) log.channels.warn({ lapsed }, 'Oxy refused a channel task; its person is told');
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
