/**
 * A realtime connection a test drives by hand: `push` delivers a frame the way the socket would,
 * and `listening` counts who listens, so a test can assert a subscription follows the screen.
 *
 * Use with:
 *
 *     vi.mock('../../src/realtime/react', async (original) =>
 *       (await import('../support/fake-realtime')).mockRealtimeReact(await original()));
 */

import type { ReactNode } from 'react';
import type { RealtimeConnection, RealtimeListener } from '../../src/realtime/connection';
import type { RealtimeFrame, RealtimeType } from '../../src/realtime/contract';

export interface FakeRealtime extends RealtimeConnection {
  push(type: RealtimeType, data: unknown, extra?: Partial<RealtimeFrame>): void;
  listening(type: RealtimeType | '*'): number;
  followed: string[];
  reset(): void;
}

export function createFakeRealtime(): FakeRealtime {
  const listeners = new Map<string, Set<RealtimeListener>>();
  const resets = new Set<() => void>();
  const statuses = new Set<(connected: boolean) => void>();
  const fake: FakeRealtime = {
    connected: true,
    followed: [],
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return () => {
        listeners.get(type)?.delete(listener);
      };
    },
    onReset(listener) {
      resets.add(listener);
      return () => resets.delete(listener);
    },
    onStatus(listener) {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
    follow(topic) {
      fake.followed.push(topic);
      return () => {
        fake.followed = fake.followed.filter((t) => t !== topic);
      };
    },
    noteSnapshot() {},
    send() {},
    listen() {
      return () => undefined;
    },
    push(type, data, extra = {}) {
      const frame = { v: 1, type, data, ...extra } as RealtimeFrame;
      for (const key of [type, '*']) for (const l of [...(listeners.get(key) ?? [])]) l(frame);
    },
    listening(type) {
      return listeners.get(type)?.size ?? 0;
    },
    reset() {
      listeners.clear();
      resets.clear();
      statuses.clear();
      fake.followed = [];
    },
  };
  return fake;
}

/** The one fake every mocked `realtime/react` hands out. */
export const fakeRealtime = createFakeRealtime();

/** `realtime/react` with the connection replaced by {@link fakeRealtime}. */
export function mockRealtimeReact<T extends Record<string, unknown>>(original: T): T {
  return {
    ...original,
    GemieRealtimeProvider: ({ children }: { children: ReactNode }) => children,
    useGemieRealtime: () => fakeRealtime,
  };
}
