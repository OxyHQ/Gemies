import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGemieApi } from './api';
import { renewChannelTasks } from './channel-tasks';
import { errorStatus } from './error-utils';
import { gemieQueryKeys } from './query-keys';
import { ACCOUNT_ROUTES } from './routes';

/**
 * A person's connected accounts (ADR 0035 as amended): the WhatsApp and Telegram (Business,
 * ADR 0037) accounts they connect ONCE, in Settings, and grant to the gemies that may use them.
 * At most one granted gemie answers what arrives on an account, as its replies say; every granted
 * gemie reads and sends through it when the person asks it or its tasks need it. Each is the
 * caller's own; the API never lists another person's. The Gemies and the Alia apps both manage them
 * through these hooks, `GemieConnectedAccounts` (Settings) and `GemieAccountGrants` (a gemie's
 * editor), from `@gemies/sdk/accounts`.
 */

export const GEMIE_ACCOUNT_PLATFORMS = ['whatsapp', 'telegram'] as const;
export type GemieAccountPlatform = (typeof GEMIE_ACCOUNT_PLATFORMS)[number];

/** Where an account's session is, as the API reports it (the gateway's own vocabulary). */
export const GEMIE_ACCOUNT_STATUSES = [
  'qr-pending',
  'connected',
  'disconnected',
  'paused',
  'logged-out',
  'failed',
] as const;
export type GemieAccountStatus = (typeof GEMIE_ACCOUNT_STATUSES)[number];

/** Who the answering gemie answers: everybody who writes, only the chosen chats, or nobody. */
export const GEMIE_ACCOUNT_REPLIES = ['everyone', 'chosen', 'nobody'] as const;
export type GemieAccountReplies = (typeof GEMIE_ACCOUNT_REPLIES)[number];
/** In a group: only when the message mentions or replies to the account, or never. */
export const GEMIE_ACCOUNT_GROUP_REPLIES = ['mentions', 'never'] as const;
export type GemieAccountGroupReplies = (typeof GEMIE_ACCOUNT_GROUP_REPLIES)[number];

/** One account, as `GET /me/accounts` lists it. */
export interface ConnectedAccount {
  _id: string;
  platform: GemieAccountPlatform;
  displayName: string | null;
  phoneNumber: string | null;
  status: GemieAccountStatus;
  /** Whether the platform lets a gemie write from it (Telegram Business); `null` elsewhere. */
  canReply: boolean | null;
  oxyTaskState: 'active' | 'reauth_required';
  /** The gemies that may use it. */
  gemieIds: string[];
  /** The one that answers what arrives on it, or `null` when none does. */
  answeringGemieId: string | null;
  replies: GemieAccountReplies;
  replyChatIds: string[];
  groupReplies: GemieAccountGroupReplies;
  lastActiveAt: string | null;
}

/** A gemie an account can be granted to: Alia, and the person's own. */
export interface GrantableGemie {
  id: string;
  name: string;
}

/** One chat of an account, to choose which ones it answers. */
export interface GemieAccountChat {
  chatId: string;
  name: string;
  kind: 'direct' | 'group';
}

/**
 * A connection waiting to be finished: WhatsApp's code to scan, or Telegram's t.me link to open
 * (or scan from another device).
 */
export interface GemieAccountLink {
  accountId: string;
  qr: string | null;
}

export interface ConnectedAccountsAnswer {
  accounts: ConnectedAccount[];
  /** The gemies the person can grant an account to. */
  gemies: GrantableGemie[];
  /** The platforms this deployment can connect now: only those are offered. */
  platforms: GemieAccountPlatform[];
}

/**
 * The caller's accounts, each as its session is now with its grants, and what can be connected.
 * When an account's answering gemie's Oxy task lapsed, the person's channels are renewed on the way
 * (`renewChannelTasks`: the provider link is kept; the person looking is the verified requester);
 * one that could not be renewed stays typed inactive for the next visit to retry. An account nobody
 * answers holds no task to renew.
 */
export function useConnectedAccounts() {
  const api = useGemieApi();
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: gemieQueryKeys.accounts.all,
    queryFn: async (): Promise<ConnectedAccountsAnswer> => {
      const { data } = await api.get<ConnectedAccountsAnswer>(ACCOUNT_ROUTES.all);
      const lapsed = data.accounts.filter(
        (account) => account.answeringGemieId && account.oxyTaskState === 'reauth_required',
      );
      if (lapsed.length === 0) return data;
      try {
        const { renewed } = await renewChannelTasks(api);
        for (const account of lapsed) {
          if (renewed.some((ref) => ref.kind === 'account' && ref.id === account._id)) {
            account.oxyTaskState = 'active';
          }
        }
      } catch {
        /* Remains typed inactive; the next verified visit may retry. */
      }
      return data;
    },
    enabled: isAuthenticated,
  });
}

/**
 * The code of an account being connected, refreshed while it waits (WhatsApp rotates its code
 * every few seconds; Telegram's link is renewed when it expires, and is gone once Telegram knows
 * who the person is). It stops once the session leaves `qr-pending`, and the list is re-read then,
 * so the account shows as it is.
 */
export function useConnectedAccountQr(link: GemieAccountLink | null) {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  const accountId = link?.accountId ?? '';
  return useQuery({
    queryKey: gemieQueryKeys.accounts.qr(accountId),
    queryFn: async (): Promise<{ status: GemieAccountStatus; qr: string | null }> => {
      const { data } = await api.get<{ status: GemieAccountStatus; qr: string | null }>(
        `${ACCOUNT_ROUTES.one(accountId)}/qr`,
      );
      if (data.status !== 'qr-pending') {
        await queryClient.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all });
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
export function useConnectedAccountChats(accountId: string) {
  const api = useGemieApi();
  return useQuery({
    queryKey: gemieQueryKeys.accounts.chats(accountId),
    queryFn: async (): Promise<GemieAccountChat[]> => {
      try {
        const { data } = await api.get<{ chats: GemieAccountChat[] }>(
          `${ACCOUNT_ROUTES.one(accountId)}/chats`,
        );
        return data.chats;
      } catch (error) {
        if (errorStatus(error) === 404) return [];
        throw error;
      }
    },
  });
}

/** What can be changed of an account: who answers it, and whom that gemie answers. */
export interface ConnectedAccountPatch {
  /** The gemie that answers it (granted it on the way), or `null` for none. */
  answeringGemieId?: string | null;
  replies?: GemieAccountReplies;
  replyChatIds?: string[];
  groupReplies?: GemieAccountGroupReplies;
}

/**
 * Connecting, granting, who answers, and removing (its session ends and its task is revoked).
 * Every write re-reads the list, so each screen that shows an account shows it as it now is.
 */
export function useConnectedAccountMutations() {
  const api = useGemieApi();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all });

  const connect = useMutation({
    mutationFn: async (platform: GemieAccountPlatform): Promise<GemieAccountLink> => {
      const { data } = await api.post<GemieAccountLink>(ACCOUNT_ROUTES.all, { platform });
      return data;
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: async ({ accountId, ...patch }: ConnectedAccountPatch & { accountId: string }) => {
      await api.patch(ACCOUNT_ROUTES.one(accountId), patch);
    },
    onSuccess: invalidate,
  });

  const grant = useMutation({
    mutationFn: async (input: { accountId: string; gemieId: string; granted: boolean }) => {
      const path = ACCOUNT_ROUTES.grant(input.accountId, input.gemieId);
      await (input.granted ? api.put(path) : api.delete(path));
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (accountId: string) => {
      await api.delete(ACCOUNT_ROUTES.one(accountId));
    },
    onSuccess: invalidate,
  });

  return { connect, update, grant, remove };
}
