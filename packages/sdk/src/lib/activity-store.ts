import { create } from 'zustand';
import type { GemieAvatarState } from '../components/GemieAvatar';

type Sources = Readonly<Record<string, GemieAvatarState>>;

/**
 * The turns running in THIS app, one entry per `useConversationThread` instance, so every chat
 * drives every "Ask Alia" button. What the person's gemies do elsewhere is the realtime activity
 * store's (`realtime/activity.ts`); `useGemieActivity` shows the busier of the two. An idle source
 * holds no entry, so the map does not grow with use.
 */
interface GemieActivityStore {
  local: Sources;
  setLocal(source: string, state: GemieAvatarState): void;
}

function put(map: Sources, key: string, state: GemieAvatarState): Sources {
  if (state === 'idle') {
    if (!(key in map)) return map;
    const { [key]: _gone, ...rest } = map;
    return rest;
  }
  return map[key] === state ? map : { ...map, [key]: state };
}

export const useGemieActivityStore = create<GemieActivityStore>((set) => ({
  local: {},
  setLocal: (source, state) => set((s) => ({ local: put(s.local, source, state) })),
}));

/** The most telling thing any source is doing: a tool call outranks thinking, thinking outranks writing. */
const RANK: Record<GemieAvatarState, number> = { idle: 0, writing: 1, thinking: 2, working: 3 };

export function busiest(...maps: ReadonlyArray<Sources>): GemieAvatarState {
  let top: GemieAvatarState = 'idle';
  for (const map of maps) {
    for (const state of Object.values(map)) if (RANK[state] > RANK[top]) top = state;
  }
  return top;
}

/** A primitive, so a subscriber re-renders when the state changes and not when a source does. */
export const selectGemieActivity = (s: GemieActivityStore): GemieAvatarState => busiest(s.local);
