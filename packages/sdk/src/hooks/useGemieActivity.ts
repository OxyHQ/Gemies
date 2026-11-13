import type { GemieAvatarState } from '../components/GemieAvatar';
import { selectGemieActivity, useGemieActivityStore } from '../lib/activity-store';
import { GEMIES_API_URL } from '../lib/origins';
import type { ActorActivityEntry } from '../realtime/activity';
import { useRealtimeActivityStore } from '../realtime/activity';
import { useRealtimeActivityFeed } from '../realtime/react';

export interface UseGemieActivityOptions {
  /** The API to hear from when no `GemieRuntimeProvider` is mounted. Defaults to Gemies's. */
  apiUrl?: string;
}

/** A tool in use is the avatar's `working`; the other states are its own. */
const AVATAR_STATE: Record<ActorActivityEntry['state'], GemieAvatarState> = {
  thinking: 'thinking',
  writing: 'writing',
  tool: 'working',
};
const RANK: Record<GemieAvatarState, number> = { idle: 0, writing: 1, thinking: 2, working: 3 };

function busiestRemote(entries: Readonly<Record<string, ActorActivityEntry>>): GemieAvatarState {
  let top: GemieAvatarState = 'idle';
  for (const entry of Object.values(entries)) {
    const state = AVATAR_STATE[entry.state];
    if (RANK[state] > RANK[top]) top = state;
  }
  return top;
}

/**
 * What Alia is doing right now, for any surface that wants to show it — an "Ask Alia" button's
 * avatar, a status dot. It is the busiest of:
 *
 * - a turn running in this app (`useConversationThread`, so every chat drives every button), and
 * - what the signed-in person's gemies are doing elsewhere (background work, another device), heard
 *   as `activity` on the account's realtime connection: the runtime provider's, or one held here
 *   while signed in when the button is drawn outside any.
 */
export function useGemieActivity(options: UseGemieActivityOptions = {}): GemieAvatarState {
  useRealtimeActivityFeed(options.apiUrl ?? GEMIES_API_URL);
  const local = useGemieActivityStore(selectGemieActivity);
  const remote = useRealtimeActivityStore((s) => busiestRemote(s.entries));
  return RANK[remote] > RANK[local] ? remote : local;
}
