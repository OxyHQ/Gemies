import {
  AGENT_ROUTES,
  answerSource,
  type GemieApi,
  type GemieThreadAddress,
  gemieRead,
  gemieThread,
  retryThreadRead,
  threadKey,
  useAnswer,
  useGemieApi,
  usePrefetchConversation,
} from '@gemies/sdk/runtime';
import { type RecordView, skip, useStore, withStore } from '@oxy.so/bloom-data';
import { useCallback } from 'react';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';

/**
 * The permanent thread between the signed-in person and one agent.
 *
 * `/@pepe` is not a link to a conversation, it is the conversation — one per
 * (person, agent) pair, the way a DM is one per pair. `GET /agents/thread/:username`
 * resolves the username through Oxy's global namespace and answers with that
 * pair's conversation, creating it the first time; a gemie with no handle (no Oxy
 * account) is asked by its id, `GET /agents/:id/thread`, for the same answer.
 * Opening the same URL twice is the same thread; two people opening the same
 * agent are two threads.
 *
 * ## Three of the agent's fields are nullable, and that is the ordinary path
 *
 * `name`, `handle` and `color` live on the agent's Oxy bot account and are
 * resolved through a batched lookup that FAILS OPEN. An account Oxy cannot
 * resolve — deleted, federated, or simply unreachable — arrives with all three
 * null while the thread itself is perfectly usable, because the conversation and
 * the tagline are Alia's own. Every reader therefore renders a fallback rather
 * than asserting.
 *
 * ## 404 is the only refusal, and it must stay that way
 *
 * An agent that does not exist and an agent this person cannot reach answer
 * IDENTICALLY. A 403 would confirm the agent exists, which is exactly what an
 * unpublished agent's owner did not agree to — so the screen shows one message
 * for both and this hook does not retry either.
 *
 * ## One read, the SDK's
 *
 * The thread is the SDK's `gemieThread` answer (the same `GET`), held in the signed-in account's
 * store and copied to its durable store: a reopened thread knows its conversation from the first
 * frame, and the chat starting its next stretch reads it again (`useRefreshGemieThread`), so this
 * screen and the chat never disagree about which stretch is live. One stretch named by
 * `?threadId=` is read on its own (`threadStretch`), in memory only.
 */
interface AgentThreadIdentity {
  _id: string;
  name: string | null;
  handle: string | null;
  /** The agent's look apart from its colour, as the server stores it (JSON). */
  character: unknown;
  /** Its colour, its account's: it paints the character and themes the page. */
  color: string | null;
  tagline: string;
  description: string;
}

export interface AgentThread {
  agent: AgentThreadIdentity;
  conversationId: string;
  threadId?: string;
}

/** How long one stretch's answer is good: like the thread's, five minutes. */
const THREAD_STALE_MS = 5 * 60 * 1000;

/**
 * One stretch of a thread (`?threadId=`): which conversation it is, with the agent's identity.
 * Memory only: a link to a past stretch is opened from a notification or a search, not drawn by the
 * sidebar.
 */
export const threadStretch = answerSource('alia.thread-stretch', {
  ...gemieRead,
  key: (thread: GemieThreadAddress, threadId: string) => `${threadKey(thread)}\u0000${threadId}`,
  stale: THREAD_STALE_MS,
  /** A 404 is an ANSWER here, not a failure to get one (see above): it is never asked again. */
  retry: retryThreadRead,
  load: async ({ signal }, thread, threadId): Promise<AgentThread> => {
    const response = await apiClient.get<{
      thread: { id: string; agentId: string };
      conversationId: string | null;
    }>(API_ROUTES.agents.threadById(threadId), { signal });
    if (!response.data.conversationId) throw new Error('Agent thread has no active conversation');
    const identity = await apiClient.get<AgentThread>(AGENT_ROUTES.thread(thread), { signal });
    return {
      agent: identity.data.agent,
      conversationId: response.data.conversationId,
      threadId: response.data.thread.id,
    };
  },
});

/** Whether an address names a thread: a non-empty handle or gemie id. */
function addresses(thread: GemieThreadAddress): boolean {
  return ('handle' in thread ? thread.handle : thread.gemieId).length > 0;
}

/** The thread's answer as this app reads it: the server sends the agent's colour too. */
const asAgentThread = (view: RecordView<unknown>) => view as RecordView<AgentThread>;

export function useAgentThread(
  thread: GemieThreadAddress,
  threadId?: string,
): RecordView<AgentThread> {
  const api = useGemieApi();
  const addressed = addresses(thread);
  const whole = asAgentThread(
    useAnswer(gemieThread, ...(addressed && threadId === undefined ? [api, thread] : [skip])),
  );
  const stretch = useAnswer(
    threadStretch,
    ...(addressed && threadId !== undefined ? [thread, threadId] : [skip]),
  );
  return threadId === undefined ? whole : stretch;
}

/**
 * Read an agent's thread ahead of the press that opens it, and the conversation behind it.
 *
 * ONLY for an agent the person has already talked to: opening a thread CREATES it the first time
 * it is asked, so asking it for an agent never opened would make threads nobody started. The
 * caller says so with `hasThread`.
 */
export function usePrefetchAgentThread(): (thread: GemieThreadAddress, hasThread: boolean) => void {
  const api = useGemieApi();
  const store = useStore();
  const prefetchConversation = usePrefetchConversation();
  return useCallback(
    (thread, hasThread) => {
      if (!hasThread || !addresses(thread)) return;
      // Best effort: a read that fails leaves nothing behind (`fetch` never rejects).
      void withStore(store, () => gemieThread.fetch(api, thread)).then(() => {
        const held = withStore(store, () => heldThread(api, thread));
        if (held) prefetchConversation(held.conversationId);
      });
    },
    [api, store, prefetchConversation],
  );
}

/** The thread the account's store holds for an address, if any (in the store in scope). */
function heldThread(api: GemieApi, thread: GemieThreadAddress) {
  return gemieThread.entity.get(gemieThread.key(api, thread))?.value;
}
