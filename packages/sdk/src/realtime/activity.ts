/**
 * Who is doing what, live: WhatsApp's "typing…" for gemies (`activity` frames, `docs/realtime.mdx`).
 *
 * One entry per actor per place (a conversation, or an agent session with none). An entry lives
 * for the `ttlMs` its frame states and is renewed by the server's heartbeat; `idle` removes it at
 * once, and so does a lost connection — a stale "typing…" is worse than none, and a reconnect hears
 * the truth within one heartbeat.
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ActivityState, RealtimeActivity } from './contract';

export interface ActorActivityEntry {
  readonly conversationId: string | null;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly name: string | null;
  readonly state: Exclude<ActivityState, 'idle'>;
  readonly tool: string | null;
}

interface RealtimeActivityStore {
  readonly entries: Readonly<Record<string, ActorActivityEntry>>;
  apply(activity: RealtimeActivity): void;
  clear(): void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function keyOf(activity: RealtimeActivity): string {
  const place = activity.conversationId ?? `session:${activity.sessionId ?? ''}`;
  return `${place}|${activity.actor.agentId ?? 'alia'}`;
}

function without(
  entries: Readonly<Record<string, ActorActivityEntry>>,
  key: string,
): Readonly<Record<string, ActorActivityEntry>> {
  if (!(key in entries)) return entries;
  const { [key]: _gone, ...rest } = entries;
  return rest;
}

export const useRealtimeActivityStore = create<RealtimeActivityStore>((set) => ({
  entries: {},
  apply(activity) {
    const key = keyOf(activity);
    const pending = timers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    timers.delete(key);
    if (activity.state === 'idle') {
      set((s) => ({ entries: without(s.entries, key) }));
      return;
    }
    const entry: ActorActivityEntry = {
      conversationId: activity.conversationId,
      sessionId: activity.sessionId ?? null,
      agentId: activity.actor.agentId,
      name: activity.actor.name ?? null,
      state: activity.state,
      tool: activity.tool ?? null,
    };
    set((s) => ({ entries: { ...s.entries, [key]: entry } }));
    timers.set(
      key,
      setTimeout(
        () => {
          timers.delete(key);
          set((s) => ({ entries: without(s.entries, key) }));
        },
        Math.max(1_000, activity.ttlMs),
      ),
    );
  },
  clear() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    set((s) => (Object.keys(s.entries).length === 0 ? s : { entries: {} }));
  },
}));

/** Who is active in one conversation. Use with `useShallow`, so it re-renders on a change only. */
export function selectConversationActivity(conversationId: string | null | undefined) {
  return (s: RealtimeActivityStore): ActorActivityEntry[] =>
    conversationId
      ? Object.values(s.entries).filter((entry) => entry.conversationId === conversationId)
      : [];
}

/** Who is doing what in one conversation right now: "Pepe is typing…", "Alia is thinking…". */
export function useConversationActivity(
  conversationId: string | null | undefined,
): readonly ActorActivityEntry[] {
  return useRealtimeActivityStore(useShallow(selectConversationActivity(conversationId)));
}
