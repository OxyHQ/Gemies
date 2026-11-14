/** A continuation a person asked for in a live chat turn, bound to that turn's session. */
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { agentSessions } from '../../db/schema/agent-sessions.js';
import { followUpReceipt, followUpRefusal, scheduleAgentFollowUp } from './follow-ups.js';

export async function scheduleChatFollowUp(input: {
  agentId: string;
  ownerAccountId: string;
  sourceSessionId: string;
  at: Date;
  note: string;
  now: Date;
  toolCallId?: string;
}): Promise<string> {
  const refusal = followUpRefusal(input.at, input.note, input.now);
  if (refusal) return followUpReceipt({ scheduled: false, reason: refusal });
  const [source] = await getDb()
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, input.sourceSessionId));
  if (
    !source ||
    source.agentId !== input.agentId ||
    source.oxyUserId !== input.ownerAccountId ||
    source.status !== 'running' ||
    !source.chatLeaseExpiresAt ||
    !source.conversationId
  )
    return followUpReceipt({ scheduled: false, reason: 'continuation_unavailable' });
  // It runs with no session and no task: Gemies acts for the person on its own first-party
  // authority (oxy ADR 0066), and the person stops it by pausing or deleting the gemie.
  return followUpReceipt(
    await scheduleAgentFollowUp({
      ownerAccountId: input.ownerAccountId,
      agentId: input.agentId,
      sourceSessionId: source.id,
      fromChat: true,
      at: input.at,
      note: input.note,
      now: input.now,
      toolCallId: input.toolCallId,
    }),
  );
}
