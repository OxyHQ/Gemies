/** Requested work has a delivery outbox; completing inference does not acknowledge its reply. */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { agentWorkItems } from '../../db/schema/agent-work.js';
import { findAgentSessionById } from '../../db/agents/agentSessionRepository.js';
import { listMessages } from '../../db/chat/messageRepository.js';
import type { PriorToolCall } from '../tool-budget.js';
import { postAgentMessage, runResultMessage } from './agent-outreach.js';
import { log } from '../logger.js';

export async function requestedAgentWork(workId: string | null | undefined): Promise<boolean> {
  if (!workId) return false;
  const [work] = await getDb()
    .select({ mode: agentWorkItems.deliveryMode })
    .from(agentWorkItems)
    .where(eq(agentWorkItems.id, workId));
  return work?.mode === 'requested';
}

/**
 * The tool calls of the conversation a requested reply returns to, oldest first: what the tool
 * budget keeps loaded (`priorToolCalls`, `lib/tool-budget.ts`), exactly as on that conversation's
 * next chat turn. A follow-up asked for in a chat that read Inbox starts with Inbox's tools,
 * instead of a step (a whole request: system prompt and tools) spent on `loadTools`.
 */
export async function requestedWorkPriorToolCalls(
  workId: string | null | undefined,
): Promise<PriorToolCall[]> {
  if (!workId) return [];
  const db = getDb();
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, workId));
  if (work?.deliveryMode !== 'requested' || !work.sourceSessionId) return [];
  const source = await findAgentSessionById(db, work.sourceSessionId);
  if (!source?.conversationId) return [];
  const rows = await listMessages(db, work.ownerAccountId, source.conversationId);
  return rows.flatMap((row) =>
    Array.isArray(row.toolInvocations)
      ? row.toolInvocations.flatMap((call: unknown) => {
          const named = call as { toolName?: unknown; args?: unknown };
          return typeof named?.toolName === 'string'
            ? [{ toolName: named.toolName, args: named.args }]
            : [];
        })
      : [],
  );
}

export async function deliverAgentWorkResult(workId: string): Promise<void> {
  const db = getDb();
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, workId));
  if (!work || work.deliveryMode !== 'requested' || work.deliveredAt || work.status === 'cancelled')
    return;
  const session = work.sessionId ? await findAgentSessionById(db, work.sessionId) : null;
  const status = session?.status ?? work.status;
  if (status !== 'completed' && status !== 'failed') return;
  const source = work.sourceSessionId ? await findAgentSessionById(db, work.sourceSessionId) : null;
  const conversationId = session?.conversationId ?? source?.conversationId;
  if (!conversationId) throw new Error('Requested agent work has no originating conversation');
  const outcome = await postAgentMessage({
    oxyUserId: work.ownerAccountId,
    agentId: work.agentId,
    conversationId,
    kind: 'result',
    idempotencyKey: `work-result:${work.id}`,
    ...runResultMessage({ status, result: session?.result, task: work.objective }),
  });
  if (!outcome.posted) {
    if (outcome.reason === 'conversation_not_found' || outcome.reason === 'agent_not_found') {
      await db
        .update(agentWorkItems)
        .set({ status: 'cancelled', failure: outcome.reason, updatedAt: new Date() })
        .where(and(eq(agentWorkItems.id, work.id), isNull(agentWorkItems.deliveredAt)));
      return;
    }
    throw new Error(`Requested agent reply was not delivered: ${outcome.reason}`);
  }
  await db
    .update(agentWorkItems)
    .set({ status, deliveredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentWorkItems.id, work.id), isNull(agentWorkItems.deliveredAt)));
}

/** Retry delivery without rerunning the agent or charging for more inference. */
export async function deliverPendingAgentWorkResults(): Promise<void> {
  const rows = await getDb()
    .select({ id: agentWorkItems.id })
    .from(agentWorkItems)
    .where(
      and(
        eq(agentWorkItems.deliveryMode, 'requested'),
        isNull(agentWorkItems.deliveredAt),
        inArray(agentWorkItems.status, ['completed', 'failed']),
      ),
    )
    .orderBy(agentWorkItems.updatedAt)
    .limit(100);
  for (const row of rows) {
    try {
      await deliverAgentWorkResult(row.id);
    } catch (err) {
      log.agents.warn({ err, workId: row.id }, 'Requested reply remains pending delivery');
      // Rotate an unavailable destination behind other pending deliveries.
      await getDb()
        .update(agentWorkItems)
        .set({ updatedAt: new Date() })
        .where(and(eq(agentWorkItems.id, row.id), isNull(agentWorkItems.deliveredAt)));
    }
  }
}
