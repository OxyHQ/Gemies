/**
 * The thread a person holds with a gemie (ADR 0009, ADR 0034): the ONE place that says which of
 * their conversations it is.
 *
 * Every gemie has one, opened, paged and searched through the same routes (`routes/agents/thread.ts`)
 * and the same reads (`findActiveThreadConversation`, `listThreadPage`, `listThreadWindow`,
 * `searchThread`). What differs is only which conversations of the (person, gemie) pair are its
 * stretches, and that is read from the gemie's configuration, never from its id:
 *
 *  - **A gemie whose chat turns are thread turns** (`task_authority = 'session'`, every persona):
 *    every conversation the person holds with it is a stretch of its thread. The thread is the pair,
 *    as it always was; nothing is written to mark it.
 *  - **A gemie whose chats are loose** (`task_authority = 'standing'`, Alia): a chat with her is a
 *    conversation of its own, the way ChatGPT's are, and stays one. Her thread is ONE `agent_threads`
 *    row per person, and its stretches are the conversations that carry that row's id in
 *    `conversations.agent_thread_id`. A loose chat carries none, so it is never in the thread and the
 *    thread is never among the loose chats.
 *
 * Who speaks in the thread does not change: a turn in a stretch of Alia's thread is a turn of her
 * gemie like any other — Nilo memory, the person's reach, her tools, standing authority and no agent
 * session (`routes/v1/chat-completions.ts` reads `taskAuthority`, not the conversation).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AgentRecord } from '../db/agents/agentRepository.js';
import { createAgentThread, findFirstAgentThread } from '../db/agents/agentRuntimeRepository.js';
import {
  createConversation,
  findActiveThreadConversation,
  type ConversationRow,
} from '../db/chat/conversationRepository.js';
import type { ThreadScope } from '../db/chat/messageRepository.js';
import type { ApiDatabase, Executor } from '../db/index.js';
import { agentPromptName, type HydratedAgent } from './agent-identity.js';

type ThreadGemie = Pick<AgentRecord, '_id' | 'taskAuthority'>;

/**
 * Whether every conversation the person holds with this gemie is its thread. `standing` is the one
 * configuration with loose chats; anything else — the column's default, `session` — is the pair.
 */
export function threadIsThePair(agent: Pick<AgentRecord, 'taskAuthority'>): boolean {
  return agent.taskAuthority !== 'standing';
}

/**
 * The scope of the person's thread with this gemie, for a read (a page, a window, a search).
 *
 * `null` when the gemie keeps loose chats and the person has never opened its thread: there is no
 * thread to read, and the pair would be every loose chat, which is exactly what the thread is not.
 */
export async function findGemieThread(
  db: Executor,
  agent: ThreadGemie,
  oxyUserId: string,
): Promise<ThreadScope | null> {
  if (threadIsThePair(agent)) return { oxyUserId, agentId: agent._id };
  const row = await findFirstAgentThread(db, oxyUserId, agent._id);
  return row === undefined ? null : { oxyUserId, agentId: agent._id, agentThreadId: row.id };
}

/** The thread, opened: its scope, and the stretch a turn is sent to. */
export interface OpenedGemieThread {
  readonly scope: ThreadScope;
  /** The ACTIVE stretch: the newest conversation of the thread, or a new one the first time. */
  readonly conversation: ConversationRow;
}

/**
 * The name a new stretch is titled with. A gemie with the person's reach is the base identity,
 * Alia, whose Oxy account does not resolve to a name yet (`lib/tools/agent-turn.ts` names her the
 * same way); `agentPromptName` would title her thread "Agent".
 */
function stretchTitle(agent: HydratedAgent): string {
  return agent.reach === 'person' ? 'Alia' : agentPromptName(agent);
}

/**
 * Open the person's thread with this gemie: the active stretch, created the first time.
 *
 * For a gemie with loose chats the `agent_threads` row is found or created under a per-pair advisory
 * lock, so two devices opening the thread at once open the SAME one. Nothing unique can say so: a
 * persona may hold many `agent_threads` rows with one person (ADR 0009), and which gemie keeps loose
 * chats is configuration, not something an index can name.
 */
export async function openGemieThread(
  db: ApiDatabase,
  agent: HydratedAgent,
  oxyUserId: string,
): Promise<OpenedGemieThread> {
  const stretch = (tx: Executor, agentThreadId?: string) =>
    createConversation(tx, {
      oxyUserId,
      conversationId: randomUUID(),
      title: stretchTitle(agent),
      source: 'app',
      agentId: agent._id,
      ...(agentThreadId === undefined ? {} : { agentThreadId }),
    });

  if (threadIsThePair(agent)) {
    const conversation =
      (await findActiveThreadConversation(db, oxyUserId, agent._id)) ?? (await stretch(db));
    return { scope: { oxyUserId, agentId: agent._id }, conversation };
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`gemie-thread:${agent._id}:${oxyUserId}`}))`,
    );
    const thread =
      (await findFirstAgentThread(tx, oxyUserId, agent._id)) ??
      (await createAgentThread(tx, {
        oxyUserId,
        agentId: agent._id,
        title: stretchTitle(agent),
        modelId: agent.modelId,
      }));
    const conversation =
      (await findActiveThreadConversation(tx, oxyUserId, agent._id, thread.id)) ??
      (await stretch(tx, thread.id));
    return {
      scope: { oxyUserId, agentId: agent._id, agentThreadId: thread.id },
      conversation,
    };
  });
}
