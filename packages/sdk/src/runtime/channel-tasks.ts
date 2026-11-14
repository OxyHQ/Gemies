import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GemieApi } from './api';
import { useGemieApi } from './api';
import { errorStatus } from './error-utils';
import { gemieQueryKeys } from './query-keys';
import { ACCOUNT_ROUTES } from './routes';

/**
 * A person's channels' Oxy tasks: the authority each channel of theirs acts with — a connected
 * account a gemie answers, a link to a system bot, a gemie's own Telegram bot they linked their
 * Telegram to. Oxy lets only the person's present session mint one, so the apps renew them the
 * way they renew every standing authority: silently while the person is in the app
 * ({@link useChannelTaskRenewal}), and with one tap from the notice they get when a channel needs
 * them ({@link useReauthorizeChannels}). The API renews only what is due: lapsed, undated, or
 * lapsing within its renewal window.
 */

export const CHANNEL_TASK_KINDS = ['account', 'bot_link', 'gemie_bot'] as const;
export type ChannelTaskKind = (typeof CHANNEL_TASK_KINDS)[number];

/** One channel: its kind, and its own id (a connected account's `_id`, for an `account`). */
export interface ChannelTaskRef {
  kind: ChannelTaskKind;
  id: string;
}

/** What one renewal did. */
export interface ChannelTaskRenewal {
  renewed: ChannelTaskRef[];
  /** The channels that still need the person: a gemie they may no longer grant, Oxy refusing. */
  failed: ChannelTaskRef[];
}

/** Renew every channel of the signed-in person that needs it, with their present session. */
export async function renewChannelTasks(api: GemieApi): Promise<ChannelTaskRenewal> {
  const { data } = await api.post<ChannelTaskRenewal>(ACCOUNT_ROUTES.renewChannelTasks);
  return data;
}

/**
 * The silent handshake: once a session for the signed-in account, as the apps' agents' work
 * handshake (`POST /agents/:id/work`). Mount it once, where the app is signed in; it draws
 * nothing. A renewed connected account re-reads the accounts list.
 */
export function useChannelTaskRenewal(): void {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  const { user, isAuthenticated } = useOxy();
  const userId = user?.id ?? '';
  useQuery({
    queryKey: gemieQueryKeys.accounts.channelTaskRenewal(userId),
    queryFn: async () => {
      const renewal = await renewChannelTasks(api);
      if (renewal.renewed.some((ref) => ref.kind === 'account')) {
        await queryClient.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all });
      }
      return renewal;
    },
    enabled: isAuthenticated && userId !== '',
    staleTime: Number.POSITIVE_INFINITY,
    // A session that is not the person's (401/403) will not become theirs by asking again.
    retry: (attempt, error) => attempt < 2 && ![401, 403].includes(errorStatus(error) ?? 0),
  });
}

/**
 * The one-tap reauthorisation the notice links to: the tap is the person's say-so, and their
 * present session renews every channel that needs it. Re-reads the accounts list after.
 */
export function useReauthorizeChannels() {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => renewChannelTasks(api),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all }),
  });
}
