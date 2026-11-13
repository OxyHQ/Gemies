import { useEffect, useRef } from 'react';
import { useGemieRealtime } from '../realtime/react';
import {
  applyRoomEvent,
  roomFailureReason,
  type RoomFailureReason,
  type RoomEvent,
  type RoomLedger,
} from './room-events';
import type { Message } from './types';

/**
 * While a conversation is open, fold its room's events (`room` frames on the realtime socket,
 * ADR 0025) into the thread. Group turns and reaction-triggered agent replies share this lifecycle.
 */
/**
 * How long a room may say nothing while a member still shows as typing before the thread stops
 * waiting. Events reach the socket at most once, so a dropped connection can lose the `group.idle`
 * that would have ended it; a member's turn is bounded well inside this, and streaming deltas keep
 * resetting it while anyone is actually speaking.
 */
export const ROOM_SILENCE_MS = 120_000;
const SILENCE_CHECK_MS = 15_000;

export function useRoomEvents(
  conversationId: string | undefined,
  ledger: RoomLedger,
  setMessages: (update: (prev: Message[]) => Message[]) => void,
  onFailure?: (failure: { chainId: string; reason: RoomFailureReason }) => void,
): void {
  const realtime = useGemieRealtime();
  const failureRef = useRef(onFailure);
  failureRef.current = onFailure;
  useEffect(() => {
    if (!conversationId || !realtime) return;
    let lastEventAt = Date.now();
    const failedChains = new Set<string>();
    const unsubscribe = realtime.on('room', (frame) => {
      const event = frame.data as RoomEvent;
      if (event?.conversationId !== conversationId) return;
      lastEventAt = Date.now();
      setMessages((prev) => applyRoomEvent(prev, ledger, conversationId, event));
      const reason =
        event.event === 'group.idle' && event.data !== null && typeof event.data === 'object'
          ? roomFailureReason((event.data as { reason?: unknown }).reason)
          : null;
      if (
        event.conversationId === conversationId &&
        reason !== null &&
        typeof event.chainId === 'string' &&
        event.chainId !== '' &&
        !failedChains.has(event.chainId)
      ) {
        failedChains.add(event.chainId);
        failureRef.current?.({ chainId: event.chainId, reason });
      }
    });
    // A quiet room whose `group.idle` was lost: end it the way that event would have. Nothing open
    // means `applyRoomEvent` hands back the same array and nothing re-renders.
    const timer = setInterval(() => {
      if (Date.now() - lastEventAt < ROOM_SILENCE_MS) return;
      lastEventAt = Date.now();
      setMessages((prev) =>
        applyRoomEvent(prev, ledger, conversationId, {
          conversationId,
          event: 'group.idle',
          data: { reason: 'silent' },
        }),
      );
    }, SILENCE_CHECK_MS);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [conversationId, ledger, realtime, setMessages]);
}
