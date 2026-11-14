/**
 * Conversations between gemies (ADR 0041), on Postgres.
 *
 * One conversation per pair of gemies and person, reopened every time one of them writes to the
 * other, as a person's chat with a friend is. It is an ordinary conversation (the room gemie's, with
 * both gemies in `conversation_members`) plus one `gemie_conversations` row that names the pair and
 * marks it as theirs: the person reads it and never writes in it.
 */

import { isUniqueViolation } from '@oxy.so/db';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../index';
import { gemieConversations } from '../schema/chat';
import { createGroupConversation } from './conversationMemberRepository';

const PAIR_KEY = 'gemie_conversations_pair_key';

/** The two ids in the one order the pair is stored in. */
export function gemiePair(a: string, b: string): { first: string; second: string } {
  if (a === b) throw new Error('A gemie does not talk to itself');
  return a < b ? { first: a, second: b } : { first: b, second: a };
}

async function findByPair(
  db: Executor,
  oxyUserId: string,
  a: string,
  b: string,
): Promise<string | undefined> {
  const { first, second } = gemiePair(a, b);
  const [row] = await db
    .select({ conversationId: gemieConversations.conversationId })
    .from(gemieConversations)
    .where(
      and(
        eq(gemieConversations.oxyUserId, oxyUserId),
        eq(gemieConversations.firstAgentId, first),
        eq(gemieConversations.secondAgentId, second),
      ),
    )
    .limit(1);
  return row?.conversationId;
}

/**
 * The conversation `fromAgentId` and `toAgentId` have for this person: the one they already have,
 * or a new one. Two first messages at once open ONE conversation: the loser of the pair key reads
 * the winner's.
 */
export async function openGemieConversation(
  db: Executor,
  input: {
    readonly oxyUserId: string;
    readonly fromAgentId: string;
    readonly toAgentId: string;
    /** The pair's names, for the conversation's title. */
    readonly title: string;
  },
): Promise<{ conversationId: string; created: boolean }> {
  const existing = await findByPair(db, input.oxyUserId, input.fromAgentId, input.toAgentId);
  if (existing !== undefined) return { conversationId: existing, created: false };
  const { first, second } = gemiePair(input.fromAgentId, input.toAgentId);
  const conversationId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await createGroupConversation(tx, {
        oxyUserId: input.oxyUserId,
        conversationId,
        title: input.title.slice(0, 100),
        source: 'app',
        agentIds: [input.fromAgentId, input.toAgentId],
      });
      await tx.insert(gemieConversations).values({
        oxyUserId: input.oxyUserId,
        conversationId,
        firstAgentId: first,
        secondAgentId: second,
      });
    });
    return { conversationId, created: true };
  } catch (error: unknown) {
    if (!isUniqueViolation(error, PAIR_KEY)) throw error;
    const winner = await findByPair(db, input.oxyUserId, input.fromAgentId, input.toAgentId);
    if (winner === undefined) throw error;
    return { conversationId: winner, created: false };
  }
}

/** Whether this person's conversation is one between gemies. */
export async function isGemieConversation(
  db: Executor,
  oxyUserId: string,
  conversationId: string,
): Promise<boolean> {
  return (await gemieConversationIdsFor(db, oxyUserId, [conversationId])).has(conversationId);
}

/** Which of these conversations are between gemies, in one query, for a listing. */
export async function gemieConversationIdsFor(
  db: Executor,
  oxyUserId: string,
  conversationIds: readonly string[],
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const rows = await db
    .select({ conversationId: gemieConversations.conversationId })
    .from(gemieConversations)
    .where(
      and(
        eq(gemieConversations.oxyUserId, oxyUserId),
        inArray(gemieConversations.conversationId, [...conversationIds]),
      ),
    );
  return new Set(rows.map((row) => row.conversationId));
}
