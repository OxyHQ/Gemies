import { useEffect } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import type { GemieAvatarState } from '../components/GemieAvatar';
import { selectGemieActivity, useGemieActivityStore } from '../lib/activity-store';
import { acquireActivitySocket } from '../lib/activity-socket';
import { GEMIES_API_URL } from '../lib/origins';

export interface UseGemieActivityOptions {
  /** The API the activity socket connects to. Defaults to the runtime's `apiUrl`. */
  apiUrl?: string;
}

/**
 * What Alia is doing right now, for any surface that wants to show it — an "Ask Alia" button's
 * avatar, a status dot. It is the busiest of:
 *
 * - a turn running in this app (`useConversationThread`, so every chat drives every button), and
 * - her runs for the signed-in person elsewhere, reported by the server over one shared socket
 *   (background work, another device), connected only while someone is signed in AND using this.
 */
export function useGemieActivity(options: UseGemieActivityOptions = {}): GemieAvatarState {
  const { apiUrl = GEMIES_API_URL } = options;
  const { oxyServices, isAuthenticated } = useOxy();

  useEffect(() => {
    if (!isAuthenticated) return;
    return acquireActivitySocket(apiUrl, () => oxyServices.session.accessToken);
  }, [apiUrl, isAuthenticated, oxyServices]);

  return useGemieActivityStore(selectGemieActivity);
}
