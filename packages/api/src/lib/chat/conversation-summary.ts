/**
 * A conversation as a list shows it: the sidebar's row. ONE projection, read by `GET /conversations`
 * and by the realtime `conversation` event (`lib/realtime/conversations.ts`), so a row a socket
 * delivers is the row the next page load would have drawn.
 */

import type { Executor } from '../../db/index.js';
import type { ConversationRow } from '../../db/chat/conversationRepository.js';
import { listGroupMembersFor } from '../../db/chat/conversationMemberRepository.js';
import { spaceIdsForConversations } from '../../db/spaces/spaceRepository.js';
import { publicAgentId } from '../../domain/alia-gemie.js';

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly lastMessage: string | null;
  readonly source: string;
  /** The gemie it belongs to, by its public id (`null` is Alia). */
  readonly agentId: string | null;
  /** The thread this is a stretch of, so a client files it there (`lib/gemie-thread.ts`). */
  readonly threadId: string | null;
  /** A group's members, in the order they answer; empty for every other conversation. */
  readonly memberAgentIds: string[];
  /** The space whose room this is (ADR 0028), so a client files it under the space. */
  readonly spaceId: string | null;
  readonly app: string | null;
  /** Messages the person has not seen yet. */
  readonly unreadCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The rows as a list shows them, in the order given: two queries for any number of rows. */
export async function summarizeConversations(
  db: Executor,
  oxyUserId: string,
  rows: readonly ConversationRow[],
): Promise<ConversationSummary[]> {
  const ids = rows.map((row) => row.conversationId);
  const [groupMembers, spaceIds] = await Promise.all([
    listGroupMembersFor(db, oxyUserId, ids),
    spaceIdsForConversations(db, oxyUserId, ids),
  ]);
  return rows.map((row) => ({
    id: row.conversationId,
    title: row.title,
    lastMessage: row.lastMessage,
    source: row.source,
    agentId: publicAgentId(row.agentId),
    threadId: row.agentThreadId,
    memberAgentIds: groupMembers.get(row.conversationId) ?? [],
    spaceId: spaceIds.get(row.conversationId) ?? null,
    app: row.originApp,
    unreadCount: row.unreadCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}
