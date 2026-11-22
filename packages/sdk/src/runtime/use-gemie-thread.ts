import { type RecordView, skip, useStore, withStore } from '@oxy.so/bloom-data';
import { useCallback } from 'react';
import type { RealtimeData } from '../realtime/contract';
import { useRealtimeEvent } from '../realtime/react';
import { useGemieApi } from './api';
import { useAnswer } from './data/answer';
import { gemieThread, type GemieThreadInfo, threadHistory } from './data/threads';
import type { GemieThreadAddress } from './routes';

export type { GemieThreadInfo } from './data/threads';

/**
 * Open the person's thread with a gemie by its id: Alia's thread mode, since she has no handle
 * (ADR 0034). The first open CREATES the thread and its first stretch, so ask only when the person
 * opens it, never to prefetch one nobody started.
 *
 * Render the chat with what it answers: `<GemieChatContent conversationId={thread.conversationId}
 * gemieThread={{ gemieId, threadId: thread.threadId }} />`. A message that may have started a new
 * stretch (a realtime `conversation` event with appended messages) reads it again, and so does
 * starting the next stretch from the chat (`useRefreshGemieThread`).
 */
export function useGemieThread(gemieId: string | undefined): RecordView<GemieThreadInfo> {
  const api = useGemieApi();
  const view = useAnswer(
    gemieThread,
    ...((gemieId?.length ?? 0) > 0 ? [api, { gemieId: gemieId as string }] : [skip]),
  );
  useRealtimeEvent('conversation', (frame) => {
    if ((frame.data as RealtimeData['conversation']).appended?.length) void view.refresh();
  });
  return view;
}

/**
 * Read a thread again, with its history: after its next stretch started, the one that was live is
 * history, and the pages held were read before its last turns existed.
 */
export function useRefreshGemieThread(): (thread: GemieThreadAddress) => void {
  const api = useGemieApi();
  const store = useStore();
  return useCallback(
    (thread) =>
      withStore(store, () => {
        void gemieThread.refresh(api, thread);
        void threadHistory.refresh(api, thread);
      }),
    [api, store],
  );
}
