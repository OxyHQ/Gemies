import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * A gemie's own Telegram bot (ADR 0037): its owner pastes a @BotFather token, the bot takes the
 * gemie's name, description and picture, and people talk to the gemie there, alone or in groups.
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
  totalMessages: number;
  lastMessageAt: string | null;
  live: TelegramBotLive | null;
}

export interface GemieTelegramBotAnswer {
  bot: GemieTelegramBot | null;
  /** Whether this deployment can run a bot at all. */
  available: boolean;
}

/** What Telegram took of the gemie's profile, part by part. */
export interface TelegramBotProfileResult {
  name: boolean;
  description: boolean;
  photo: boolean;
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

/** Connecting, its settings, taking the gemie's profile again, and removing it. */
export function useGemieTelegramBotMutations(gemieId: string) {
  const queryClient = useQueryClient();
  const store = (bot: GemieTelegramBot | null) =>
    queryClient.setQueryData<GemieTelegramBotAnswer>(
      queryKeys.agents.telegramBot(gemieId),
      (old) => (old ? { ...old, bot } : { bot, available: true }),
    );

  const connect = useMutation({
    mutationFn: async (input: {
      token: string;
      ownerPaysAgentTurns: boolean;
      photoJpegBase64: string | null;
    }) => {
      const { data } = await apiClient.put<{
        bot: GemieTelegramBot;
        profile: TelegramBotProfileResult;
      }>(API_ROUTES.agents.telegramBot(gemieId), input);
      return data;
    },
    onSuccess: (data) => store(data.bot),
  });

  const update = useMutation({
    mutationFn: async (input: {
      groupReplies?: TelegramBotGroupReplies;
      ownerPaysAgentTurns?: boolean;
      syncProfile?: boolean;
      photoJpegBase64?: string | null;
    }) => {
      const { data } = await apiClient.patch<{
        bot: GemieTelegramBot;
        profile?: TelegramBotProfileResult;
      }>(API_ROUTES.agents.telegramBot(gemieId), input);
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

  return { connect, update, remove };
}
