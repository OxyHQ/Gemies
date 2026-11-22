import { type RecordView, skip, useList } from '@oxy.so/bloom-data';
import { useGemieApi } from './api';
import { useAnswer } from './data/answer';
import { threadSearch, threadWindow } from './data/threads';
import type { GemieThreadAddress } from './routes';
import type { ThreadMessage, ThreadSearchHit } from './thread/thread-history';
import { isThreadAddress, useHeldThreadMessages } from './use-thread-history';

/**
 * Finding something said earlier in a thread, and getting back to it.
 *
 * Two halves, and the second is why the first is worth anything: a hit tells you the message
 * exists, and its CURSOR is what opens the stretch of thread around it, however many
 * conversations back it lives. Without that, a result list is a wall you can read and not reach.
 */

export function useThreadSearch(
  thread: GemieThreadAddress | undefined,
  query: string,
): RecordView<ThreadSearchHit[]> {
  const api = useGemieApi();
  const trimmed = query.trim();
  // An empty query is not a search: asking for one would return the thread's most recent
  // everything under the guise of a result.
  return useAnswer(
    threadSearch,
    ...(isThreadAddress(thread) && trimmed.length > 0 ? [api, thread, trimmed] : [skip]),
  );
}

/**
 * The stretch of thread around one message, opened from a search hit. Reading further back from
 * here is the same paging as anywhere else. There is no paging FORWARD: the way back to the
 * present is leaving the window, not walking to it.
 */
export function useThreadWindow(thread: GemieThreadAddress | undefined, cursor: string | null) {
  const api = useGemieApi();
  const view = useList(
    threadWindow,
    ...(isThreadAddress(thread) && cursor !== null ? [api, thread, cursor] : [skip]),
  );
  // Nothing is dropped here, unlike the tail: a window is a view of the PAST, and the live
  // conversation is not on screen underneath it to be duplicated. The empty string is a
  // conversation id no message has.
  const messages: ThreadMessage[] = useHeldThreadMessages(view.ids, '');
  return {
    messages,
    hasMore: view.hasMore,
    isLoadingMore: view.isFetching && view.list !== undefined,
    loadMore: view.more,
    isLoading: view.isLoading && cursor !== null,
  };
}
