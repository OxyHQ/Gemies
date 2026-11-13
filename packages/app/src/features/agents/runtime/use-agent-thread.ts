import {
  AGENT_ROUTES,
  type GemieThreadAddress,
  threadKey,
  usePrefetchConversation,
} from '@gemies/sdk/runtime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import { errorStatus } from '@/shared/api/error-utils';

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

/** How long a thread's identity and conversation are good: they change when the person starts a stretch. */
const THREAD_STALE_MS = 5 * 60 * 1000;

/**
 * The thread's query, as a value: what `useAgentThread` runs and what a prefetch runs, so the two
 * are one question under one key and a prefetched thread is the one the screen reads.
 */
function agentThreadQuery(thread: GemieThreadAddress, threadId?: string) {
  return {
    // Under the SDK's key for the thread, so the chat starting its next stretch re-reads this.
    queryKey: [...queryKeys.agents.thread(threadKey(thread)), threadId ?? 'default'] as const,
    queryFn: async (): Promise<AgentThread> => {
      if (threadId) {
        const response = await apiClient.get<{
          thread: { id: string; agentId: string };
          conversationId: string | null;
        }>(API_ROUTES.agents.threadById(threadId));
        if (!response.data.conversationId)
          throw new Error('Agent thread has no active conversation');
        const identity = await apiClient.get<AgentThread>(AGENT_ROUTES.thread(thread));
        return {
          agent: identity.data.agent,
          conversationId: response.data.conversationId,
          threadId: response.data.thread.id,
        };
      }
      const response = await apiClient.get<AgentThread>(AGENT_ROUTES.thread(thread));
      return response.data;
    },
    // Fresh for a while, so opening a thread that was read a moment ago (or prefetched on the way
    // to it) paints from the cache and does not ask again.
    staleTime: THREAD_STALE_MS,
    /**
     * A 404 is an ANSWER here, not a failure to get one: the agent does not
     * exist, or this person cannot reach it. Retrying re-asks a question that
     * has already been answered, and does it three times before the screen is
     * allowed to say so.
     */
    retry: (failureCount: number, error: unknown) => errorStatus(error) !== 404 && failureCount < 2,
  };
}

/** Whether an address names a thread: a non-empty handle or gemie id. */
function addresses(thread: GemieThreadAddress): boolean {
  return ('handle' in thread ? thread.handle : thread.gemieId).length > 0;
}

export function useAgentThread(thread: GemieThreadAddress, threadId?: string) {
  return useQuery({
    ...agentThreadQuery(thread, threadId),
    enabled: addresses(thread),
  });
}

/**
 * Read an agent's thread ahead of the press that opens it, and the conversation behind it.
 *
 * ONLY for an agent the person has already talked to: opening a thread CREATES it the first time
 * it is asked, so asking it for an agent never opened would make threads nobody started. The
 * caller says so with `hasThread`.
 */
export function usePrefetchAgentThread(): (thread: GemieThreadAddress, hasThread: boolean) => void {
  const queryClient = useQueryClient();
  const prefetchConversation = usePrefetchConversation();
  return useCallback(
    (thread, hasThread) => {
      if (!hasThread || !addresses(thread)) return;
      const query = agentThreadQuery(thread);
      // Best effort, never retried: see `prefetchConversation` in the SDK.
      void queryClient.prefetchQuery({ ...query, retry: false }).then(() => {
        const thread = queryClient.getQueryData<AgentThread>(query.queryKey);
        if (thread) prefetchConversation(thread.conversationId);
      });
    },
    [queryClient, prefetchConversation],
  );
}
