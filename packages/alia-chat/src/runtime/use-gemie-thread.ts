import { useQuery } from '@tanstack/react-query';
import { useAliaApi } from './api';
import { aliaQueryKeys } from './query-keys';
import { AGENT_ROUTES, threadKey } from './routes';
import { retryThreadRead } from './use-thread-history';

/** A gemie's thread with the signed-in person, as `GET /agents/:id/thread` answers it. */
export interface GemieThread {
  /** Who the thread is with. `name`, `handle` and `color` come from Oxy and may be `null` (Alia's do, until her account exists). */
  readonly agent: {
    readonly _id: string;
    readonly name: string | null;
    readonly handle: string | null;
    readonly character: unknown;
    readonly tagline: string;
    readonly description: string;
  };
  /** The active stretch: `AliaChatContent`'s `conversationId`, where the next turn goes. */
  readonly conversationId: string;
  /**
   * The thread row, for a gemie whose chats are loose (Alia): her thread is apart from them, and its
   * next stretch is `useCreateConversation({ threadId })`. `null` for any other gemie, whose thread is
   * every conversation the two hold.
   */
  readonly threadId: string | null;
}

/** How long the open thread is good: it changes when the person starts a stretch, which invalidates it. */
const THREAD_STALE_MS = 5 * 60 * 1000;

/**
 * Open the person's thread with a gemie by its id — Alia's thread mode, since she has no handle
 * (ADR 0034). The first open CREATES the thread and its first stretch, so ask only when the person
 * opens it, never to prefetch one nobody started.
 *
 * Render the chat with what it answers: `<AliaChatContent conversationId={thread.conversationId}
 * gemieThread={{ gemieId, threadId: thread.threadId }} />`. Keyed under `aliaQueryKeys.threads.all`,
 * so starting the next stretch from the chat moves this onto it.
 */
export function useGemieThread(gemieId: string | undefined) {
  const api = useAliaApi();
  const address = { gemieId: gemieId ?? '' };
  return useQuery({
    queryKey: aliaQueryKeys.threads.all(threadKey(address)),
    queryFn: async (): Promise<GemieThread> => {
      const { data } = await api.get<GemieThread>(AGENT_ROUTES.thread(address));
      return data;
    },
    enabled: (gemieId?.length ?? 0) > 0,
    staleTime: THREAD_STALE_MS,
    // A 404 is an answer: the gemie does not exist or this person cannot open it.
    retry: retryThreadRead,
  });
}
