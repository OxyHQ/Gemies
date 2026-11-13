import apiClient from '@/shared/api/client';
import { errorStatus } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * A gemie's connected accounts (ADR 0035): the WhatsApp and Telegram accounts the person linked to
 * this gemie, which answers what arrives on them as their replies say. Each is the caller's own;
 * the API never lists another person's.
 */

export const GEMIE_ACCOUNT_PLATFORMS = ['whatsapp', 'telegram'] as const;
export type GemieAccountPlatform = (typeof GEMIE_ACCOUNT_PLATFORMS)[number];

/** Where an account's session is, as the API reports it (the gateway's own vocabulary). */
export const GEMIE_ACCOUNT_STATUSES = [
  'qr-pending',
  'connected',
  'disconnected',
  'logged-out',
  'failed',
] as const;
export type GemieAccountStatus = (typeof GEMIE_ACCOUNT_STATUSES)[number];

export const GEMIE_ACCOUNT_REPLIES = ['everyone', 'chosen', 'nobody'] as const;
export type GemieAccountReplies = (typeof GEMIE_ACCOUNT_REPLIES)[number];
export const GEMIE_ACCOUNT_GROUP_REPLIES = ['never', 'mentions'] as const;
export type GemieAccountGroupReplies = (typeof GEMIE_ACCOUNT_GROUP_REPLIES)[number];

/** One account, as `GET /agents/:id/accounts` lists it. */
export interface GemieAccount {
  _id: string;
  platform: GemieAccountPlatform;
  displayName: string | null;
  phoneNumber: string | null;
  status: GemieAccountStatus;
  oxyTaskState: 'active' | 'reauth_required';
  replies: GemieAccountReplies;
  replyChatIds: string[];
  groupReplies: GemieAccountGroupReplies;
  lastActiveAt: string | null;
}

/** One chat of an account, to choose which ones it answers. */
export interface GemieAccountChat {
  chatId: string;
  name: string;
  kind: 'direct' | 'group';
}

/** A link waiting for its scan. */
export interface GemieAccountLink {
  accountId: string;
  qr: string | null;
}

interface GemieAccountsAnswer {
  accounts: GemieAccount[];
  /** The platforms this deployment can link now: only those are offered. */
  platforms: GemieAccountPlatform[];
}

/**
 * The caller's accounts on this gemie, each as its session is now, and what can be linked. An
 * account whose Oxy task lapsed is renewed on the way (the provider link is kept; the person who
 * opened the editor is the verified requester); a renewal that fails leaves it typed inactive for
 * the next visit to retry.
 */
export function useGemieAccounts(agentId: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.accounts(agentId),
    queryFn: async (): Promise<GemieAccountsAnswer> => {
      const { data } = await apiClient.get<GemieAccountsAnswer>(
        API_ROUTES.agents.accounts(agentId),
      );
      await Promise.all(
        data.accounts
          .filter((account) => account.oxyTaskState === 'reauth_required')
          .map(async (account) => {
            try {
              await apiClient.post(
                `${API_ROUTES.agents.account(agentId, account._id)}/reauthorize`,
              );
              account.oxyTaskState = 'active';
            } catch {
              /* Remains typed inactive; the next verified visit may retry. */
            }
          }),
      );
      return data;
    },
    enabled: isAuthenticated && agentId !== '',
  });
}

/**
 * The code of an account being linked, refreshed while it waits (WhatsApp rotates its code every
 * few seconds). It stops once the session leaves `qr-pending`, and the list is re-read then, so the
 * account shows as it is.
 */
export function useGemieAccountQr(agentId: string, link: GemieAccountLink | null) {
  const queryClient = useQueryClient();
  const accountId = link?.accountId ?? '';
  return useQuery({
    queryKey: queryKeys.agents.accountQr(agentId, accountId),
    queryFn: async (): Promise<{ status: GemieAccountStatus; qr: string | null }> => {
      const { data } = await apiClient.get<{ status: GemieAccountStatus; qr: string | null }>(
        `${API_ROUTES.agents.account(agentId, accountId)}/qr`,
      );
      if (data.status !== 'qr-pending') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.agents.accounts(agentId) });
      }
      return data;
    },
    enabled: link !== null,
    initialData: link ? { status: 'qr-pending' as const, qr: link.qr } : undefined,
    initialDataUpdatedAt: 0,
    refetchInterval: (query) => (query.state.data?.status === 'qr-pending' ? 4000 : false),
  });
}

/** An account's recent chats, read only while the person is choosing which ones it answers. */
export function useGemieAccountChats(agentId: string, accountId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agents.accountChats(agentId, accountId),
    queryFn: async (): Promise<GemieAccountChat[]> => {
      try {
        const { data } = await apiClient.get<{ chats: GemieAccountChat[] }>(
          `${API_ROUTES.agents.account(agentId, accountId)}/chats`,
        );
        return data.chats;
      } catch (error) {
        if (errorStatus(error) === 404) return [];
        throw error;
      }
    },
    enabled,
  });
}

/** Linking, who it answers, and removing (its session ends and its task is revoked). */
export function useGemieAccountMutations(agentId: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.accounts(agentId) });

  const link = useMutation({
    mutationFn: async (platform: GemieAccountPlatform): Promise<GemieAccountLink> => {
      const { data } = await apiClient.post<GemieAccountLink>(API_ROUTES.agents.accounts(agentId), {
        platform,
      });
      return data;
    },
    onSuccess: invalidate,
  });

  const setReplies = useMutation({
    mutationFn: async (input: {
      accountId: string;
      replies?: GemieAccountReplies;
      replyChatIds?: string[];
      groupReplies?: GemieAccountGroupReplies;
    }) => {
      const { accountId, ...patch } = input;
      await apiClient.patch(API_ROUTES.agents.account(agentId, accountId), patch);
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (accountId: string) => {
      await apiClient.delete(API_ROUTES.agents.account(agentId, accountId));
    },
    onSuccess: invalidate,
  });

  return { link, setReplies, remove };
}
