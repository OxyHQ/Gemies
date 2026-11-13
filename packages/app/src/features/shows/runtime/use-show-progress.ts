/**
 * Real-time episode progress, on the SHARED notifications socket.
 *
 * The version this replaces documented exactly this — *"the actual socket
 * connection is managed by use-notification-setup"* — and then built a second
 * refcounted singleton of its own. A signed-in user on the shows screen held
 * two websockets to the same server, in the same room, so every emit arrived
 * twice and which socket a listener landed on depended on mount order.
 *
 * `src/features/notifications/runtime/notifications-socket.ts` is the one connection now. This hook adds a
 * listener and takes it away again; the connection belongs to whoever still
 * holds a reference.
 */

import { useRealtimeEvent } from '@gemies/sdk/runtime';
import { useShowStore, type ShowProgress } from '@/features/shows/runtime/show-store';

export function useShowProgress() {
  const updateProgress = useShowStore((s) => s.updateProgress);
  const fetchOneSeries = useShowStore((s) => s.fetchOneSeries);

  // `show.progress` on the account's realtime connection (`docs/realtime.mdx`).
  useRealtimeEvent('show.progress', (frame) => {
    const progress = frame.data as ShowProgress;
    updateProgress(progress);
    /**
     * A finished episode is refetched rather than patched from the event.
     *
     * The event carries a status and a percentage; what changed is the whole
     * episode — its Syra id, its duration, what it cost, and its recap. The
     * series read returns all of it, and it is the same read the screen does
     * on mount, so there is one shape rather than two.
     */
    if (progress.status === 'completed' || progress.status === 'failed') {
      void fetchOneSeries(progress.seriesId);
    }
  });
}
