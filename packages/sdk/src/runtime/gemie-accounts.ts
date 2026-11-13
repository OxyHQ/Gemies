import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGemieApi } from './api';
import { errorStatus } from './error-utils';
import { gemieQueryKeys } from './query-keys';
import { AGENT_ROUTES } from './routes';

/**
 * A gemie's connected accounts (ADR 0035): the WhatsApp and Telegram accounts the person linked to
 * a gemie, which answers what arrives on them as their replies say. Each is the caller's own; the
 * API never lists another person's. The Gemies app (in a gemie's editor) and the Alia app (for
 * Alia's gemie) both manage them through these hooks and `GemieAccounts` (`@gemies/sdk/accounts`).
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

/** Who the gemie answers: everybody who writes, only the chosen chats, or nobody. */
export const GEMIE_ACCOUNT_REPLIES = ['everyone', 'chosen', 'nobody'] as const;
export type GemieAccountReplies = (typeof GEMIE_ACCOUNT_REPLIES)[number];
/** In a group: only when the message mentions or replies to the account, or never. */
export const GEMIE_ACCOUNT_GROUP_REPLIES = ['mentions', 'never'] as const;
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

export interface GemieAccountsAnswer {
  accounts: GemieAccount[];
  /** The platforms this deployment can link now: only those are offered. */
  platforms: GemieAccountPlatform[];
}

/**
 * The caller's accounts on a gemie, each as its session is now, and what can be linked. An account
 * whose Oxy task lapsed is renewed on the way (the provider link is kept; the person looking is the
 * verified requester); a renewal that fails leaves it typed inactive for the next visit to retry.
 */
export function useGemieAccounts(gemieId: string) {
  const api = useGemieApi();
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: gemieQueryKeys.accounts.all(gemieId),
    queryFn: async (): Promise<GemieAccountsAnswer> => {
      const { data } = await api.get<GemieAccountsAnswer>(AGENT_ROUTES.accounts(gemieId));
      await Promise.all(
        data.accounts
          .filter((account) => account.oxyTaskState === 'reauth_required')
          .map(async (account) => {
            try {
              await api.post(`${AGENT_ROUTES.account(gemieId, account._id)}/reauthorize`);
              account.oxyTaskState = 'active';
            } catch {
              /* Remains typed inactive; the next verified visit may retry. */
            }
          }),
      );
      return data;
    },
    enabled: isAuthenticated && gemieId !== '',
  });
}

/**
 * The code of an account being linked, refreshed while it waits (WhatsApp rotates its code every
 * few seconds). It stops once the session leaves `qr-pending`, and the list is re-read then, so the
 * account shows as it is.
 */
export function useGemieAccountQr(gemieId: string, link: GemieAccountLink | null) {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  const accountId = link?.accountId ?? '';
  return useQuery({
    queryKey: gemieQueryKeys.accounts.qr(gemieId, accountId),
    queryFn: async (): Promise<{ status: GemieAccountStatus; qr: string | null }> => {
      const { data } = await api.get<{ status: GemieAccountStatus; qr: string | null }>(
        `${AGENT_ROUTES.account(gemieId, accountId)}/qr`,
      );
      if (data.status !== 'qr-pending') {
        await queryClient.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all(gemieId) });
      }
      return data;
    },
    enabled: link !== null,
    initialData: link ? { status: 'qr-pending' as const, qr: link.qr } : undefined,
    initialDataUpdatedAt: 0,
    refetchInterval: (query) => (query.state.data?.status === 'qr-pending' ? 4000 : false),
  });
}

/** An account's recent chats, read while the person chooses which ones it answers. */
export function useGemieAccountChats(gemieId: string, accountId: string) {
  const api = useGemieApi();
  return useQuery({
    queryKey: gemieQueryKeys.accounts.chats(gemieId, accountId),
    queryFn: async (): Promise<GemieAccountChat[]> => {
      try {
        const { data } = await api.get<{ chats: GemieAccountChat[] }>(
          `${AGENT_ROUTES.account(gemieId, accountId)}/chats`,
        );
        return data.chats;
      } catch (error) {
        if (errorStatus(error) === 404) return [];
        throw error;
      }
    },
  });
}

/** Linking, who it answers, and removing (its session ends and its task is revoked). */
export function useGemieAccountMutations(gemieId: string) {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all(gemieId) });

  const link = useMutation({
    mutationFn: async (platform: GemieAccountPlatform): Promise<GemieAccountLink> => {
      const { data } = await api.post<GemieAccountLink>(AGENT_ROUTES.accounts(gemieId), {
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
      await api.patch(AGENT_ROUTES.account(gemieId, accountId), patch);
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (accountId: string) => {
      await api.delete(AGENT_ROUTES.account(gemieId, accountId));
    },
    onSuccess: invalidate,
  });

  return { link, setReplies, remove };
}
