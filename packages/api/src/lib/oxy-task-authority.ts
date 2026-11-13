import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { log } from './logger.js';
/** Durable own-task authority binds the requester once; workers store only its id. */
import { oxy } from './oxy.js';

const TASK_LIFETIME_MS = 365 * 24 * 60 * 60_000;
const REQUEST_TASK_LIFETIME_MS = 10 * 60_000;

/**
 * When the requester's bearer stops being valid, read from its own `exp` (milliseconds), or
 * undefined for a bearer that does not say. Only a bound: Oxy verifies the bearer, and refuses a
 * request task that outlives its requester ("Task lifetime is out of range").
 */
function bearerExpiresAt(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A request task lives as long as the request may (ten minutes) and never past its requester's
 * bearer: a person's access token near the end of its life otherwise cost every task minted on it.
 * Goals and automations are durable.
 */
function taskExpiresAt(kind: 'request' | 'goal' | 'automation', accessToken: string): Date {
  const now = Date.now();
  if (kind !== 'request') return new Date(now + TASK_LIFETIME_MS);
  return new Date(
    Math.min(now + REQUEST_TASK_LIFETIME_MS, bearerExpiresAt(accessToken) ?? Infinity),
  );
}
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
      expiresAt: taskExpiresAt(input.origin.kind, input.accessToken).toISOString(),
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
        sql`not exists (select 1 from agent_work_authorities a where a.oxy_task_id = ${agentSessions.oxyTaskId})`,
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
