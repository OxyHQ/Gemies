import { skip, useEntities, useList } from '@oxy.so/bloom-data';
import { useMemo } from 'react';
import { useGemieApi } from './api';
import { ThreadMessages, threadHistory as historySource } from './data/threads';
import type { GemieThreadAddress } from './routes';
import { type ThreadMessage, type WireThreadMessage, threadHistory } from './thread/thread-history';

/**
 * Everything said in this thread before the conversation on screen, a page at a time, going back.
 *
 * The screen streams into the most recent conversation of the thread and knows nothing older;
 * the thread's messages route is what crosses the seams into the stretches before it. Pages are
 * pulled as the reader approaches the top, never eagerly: a thread has no end going backwards,
 * and the first page is already everything a reader who does not scroll will see.
 *
 * `nextCursor` is what says whether anything older remains, and it is the server's answer rather
 * than a count: a page that comes back empty after its live messages are dropped is ordinary, and
 * treating that as the end would stop the history dead on any thread whose current conversation
 * is long.
 */

/** Whether there is a thread to ask about: an address with a non-empty handle or gemie id. */
export function isThreadAddress(
  thread: GemieThreadAddress | undefined,
): thread is GemieThreadAddress {
  if (thread === undefined) return false;
  return ('handle' in thread ? thread.handle : thread.gemieId).length > 0;
}

/** A thread list's messages (held newest first) in reading order, the active stretch left out. */
export function useHeldThreadMessages(
  ids: readonly string[],
  activeConversationId: string,
): ThreadMessage[] {
  const records = useEntities(ThreadMessages, ids);
  return useMemo(() => {
    const oldestFirst = records
      .filter((message): message is WireThreadMessage => message !== undefined)
      .reverse();
    return threadHistory([{ messages: oldestFirst, nextCursor: null }], activeConversationId);
  }, [records, activeConversationId]);
}

export function useThreadHistory(
  thread: GemieThreadAddress | undefined,
  activeConversationId: string | undefined,
) {
  const api = useGemieApi();
  // Nothing to page through until the thread has answered which conversation is the live one:
  // without it every message would be history, including the ones already on screen.
  const view = useList(
    historySource,
    ...(isThreadAddress(thread) && activeConversationId !== undefined ? [api, thread] : [skip]),
  );
  const messages = useHeldThreadMessages(view.ids, activeConversationId ?? '');
  return {
    messages,
    /** Whether a page older than the ones held remains to be asked for. */
    hasMore: view.hasMore,
    isLoadingMore: view.isFetching && view.list !== undefined,
    loadMore: view.more,
  };
}
