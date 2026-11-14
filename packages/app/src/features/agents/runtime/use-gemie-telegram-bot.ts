import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * A gemie's own Telegram bot (ADR 0037): its owner pastes a @BotFather token, the bot shows the
 * gemie's name, description and picture and follows them by itself, and people talk to the gemie
 * there, alone or in groups.
 */

/** In a Telegram group: only when mentioned or replied to, or never. */
export type TelegramBotGroupReplies = 'mentions' | 'never';

/** How Telegram sees the bot now, or `null` when it could not be asked. */
export interface TelegramBotLive {
  username: string | null;
  name: string;
  canJoinGroups: boolean;
  /** False while its privacy mode is on: in a group it then sees only replies and commands. */
  canReadAllGroupMessages: boolean;
  webhook: 'ok' | 'failing' | 'missing';
  webhookError: string | null;
  pendingUpdates: number;
}

export interface GemieTelegramBot {
  botId: string;
  username: string | null;
  name: string;
  status: 'active' | 'inactive' | 'error';
  groupReplies: TelegramBotGroupReplies;
  ownerPaysAgentTurns: boolean;
  /** Whether the caller connected it, and so alone decides whether their credits pay for it. */
  callerPays: boolean;
  /**
   * Whether the person who connected it linked their own Telegram: the gemie then recognises them in
   * their private chat with the bot, with their apps, accounts, memory and tasks, as in the app.
   */
  personLinked: boolean;
  /**
   * Linked, but the authority they granted the gemie there lapsed: their private chat is a
   * stranger's until they reauthorise it (`useReauthorizeChannels`), keeping the link.
   */
  personAuthorityLapsed: boolean;
  /** Who is linked, as their Telegram showed them (`@username`, else their name); null when nobody. */
  linkedAs: string | null;
  totalMessages: number;
  lastMessageAt: string | null;
  /**
   * Why the bot does not show the gemie's latest name, description or picture yet, when an update
   * failed (it is retried by itself); null when it does.
   */
  profileSyncError: string | null;
  live: TelegramBotLive | null;
}

export interface GemieTelegramBotAnswer {
  bot: GemieTelegramBot | null;
  /** Whether this deployment can run a bot at all. */
  available: boolean;
}

export function useGemieTelegramBot(gemieId: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.telegramBot(gemieId),
    queryFn: async (): Promise<GemieTelegramBotAnswer> => {
      const { data } = await apiClient.get<GemieTelegramBotAnswer>(
        API_ROUTES.agents.telegramBot(gemieId),
      );
      return data;
    },
    enabled: isAuthenticated && gemieId !== '',
  });
}

/** Connecting, its settings, retrying its profile after a failure, and removing it. */
export function useGemieTelegramBotMutations(gemieId: string) {
  const queryClient = useQueryClient();
  const store = (bot: GemieTelegramBot | null) =>
    queryClient.setQueryData<GemieTelegramBotAnswer>(
      queryKeys.agents.telegramBot(gemieId),
      (old) => (old ? { ...old, bot } : { bot, available: true }),
    );

  const connect = useMutation({
    mutationFn: async (input: { token: string; ownerPaysAgentTurns: boolean }) => {
      const { data } = await apiClient.put<{ bot: GemieTelegramBot }>(
        API_ROUTES.agents.telegramBot(gemieId),
        input,
      );
      return data;
    },
    onSuccess: (data) => store(data.bot),
  });

  const update = useMutation({
    mutationFn: async (input: {
      groupReplies?: TelegramBotGroupReplies;
      ownerPaysAgentTurns?: boolean;
      /** Try again to give the bot its gemie's profile, after a failure. */
      retryProfileSync?: true;
    }) => {
      const { data } = await apiClient.patch<{ bot: GemieTelegramBot }>(
        API_ROUTES.agents.telegramBot(gemieId),
        input,
      );
      return data;
    },
    onSuccess: (data) => store(data.bot),
  });

  const remove = useMutation({
    mutationFn: async () => {
      await apiClient.delete(API_ROUTES.agents.telegramBot(gemieId));
    },
    onSuccess: () => store(null),
  });

  /** A one-time link that, opened in Telegram, tells the bot which Telegram account is the caller's. */
  const link = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<{ url: string; expiresAt: string }>(
        API_ROUTES.agents.telegramBotLink(gemieId),
        {},
      );
      return data;
    },
  });

  const unlink = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.delete<{ bot: GemieTelegramBot }>(
        API_ROUTES.agents.telegramBotLink(gemieId),
      );
      return data;
    },
    onSuccess: (data) => store(data.bot),
  });

  return { connect, update, remove, link, unlink };
}
