/**
 * A conversation as a list shows it: the sidebar's row. ONE projection, read by `GET /conversations`
 * and by the realtime `conversation` event (`lib/realtime/conversations.ts`), so a row a socket
 * delivers is the row the next page load would have drawn.
 */

import type { Executor } from '../../db/index.js';
import { findAgentsByIds } from '../../db/agents/agentRepository.js';
import type { ConversationRow } from '../../db/chat/conversationRepository.js';
import { listGroupMembersFor } from '../../db/chat/conversationMemberRepository.js';
import { gemieConversationIdsFor } from '../../db/chat/gemieConversationRepository.js';
import { spaceIdsForConversations } from '../../db/spaces/spaceRepository.js';
import { publicAgentId } from '../../domain/alia-gemie.js';
import type { AgentInfo } from '../../domain/conversation.js';
import { agentPromptName, attachAgentIdentities } from '../agent-identity.js';

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
  /**
   * `gemies` for a conversation the person's gemies have with each other (ADR 0041): the person
   * reads it and never writes in it. `person` for the person's own.
   */
  readonly kind: 'person' | 'gemies';
  /**
   * The two gemies of a conversation between gemies, as their messages carry them, so a client
   * draws who talks there without resolving gemies it may not list (Alia, a public one).
   */
  readonly members?: AgentInfo[];
  readonly app: string | null;
  /** Messages the person has not seen yet. */
  readonly unreadCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The identities of the gemies these conversations' members name, in one query. */
async function identitiesOf(
  db: Executor,
  agentIds: readonly string[],
): Promise<Map<string, AgentInfo>> {
  if (agentIds.length === 0) return new Map();
  const agents = await attachAgentIdentities(await findAgentsByIds(db, [...agentIds]));
  return new Map(
    agents.map((agent) => [
      agent._id,
      {
        id: agent._id,
        name: agentPromptName(agent),
        handle: agent.handle ?? '',
        color: agent.color,
        character: agent.character,
      } satisfies AgentInfo,
    ]),
  );
}

/** The rows as a list shows them, in the order given: a few queries for any number of rows. */
export async function summarizeConversations(
  db: Executor,
  oxyUserId: string,
  rows: readonly ConversationRow[],
): Promise<ConversationSummary[]> {
  const ids = rows.map((row) => row.conversationId);
  const [groupMembers, spaceIds, betweenGemies] = await Promise.all([
    listGroupMembersFor(db, oxyUserId, ids),
    spaceIdsForConversations(db, oxyUserId, ids),
    gemieConversationIdsFor(db, oxyUserId, ids),
  ]);
  const gemies = await identitiesOf(db, [
    ...new Set([...betweenGemies].flatMap((id) => groupMembers.get(id) ?? [])),
  ]);
  return rows.map((row) => {
    const memberAgentIds = groupMembers.get(row.conversationId) ?? [];
    const isBetweenGemies = betweenGemies.has(row.conversationId);
    return {
      id: row.conversationId,
      title: row.title,
      lastMessage: row.lastMessage,
      source: row.source,
      agentId: publicAgentId(row.agentId),
      threadId: row.agentThreadId,
      memberAgentIds,
      spaceId: spaceIds.get(row.conversationId) ?? null,
      kind: isBetweenGemies ? 'gemies' : 'person',
      ...(isBetweenGemies
        ? {
            members: memberAgentIds.flatMap((id) => {
              const gemie = gemies.get(id);
              return gemie ? [gemie] : [];
            }),
          }
        : {}),
      app: row.originApp,
      unreadCount: row.unreadCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}
