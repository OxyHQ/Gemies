import apiClient from '@/shared/api/client';
import { errorStatus } from '@/shared/api/error-utils';
import { queryKeys } from '@/shared/api/query-keys';
import { API_ROUTES } from '@/shared/api/routes';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * A gemie's connected accounts (ADR 0035): the WhatsApp and Telegram accounts the person linked to
 * this gemie, which answers what arrives on them. Each is the caller's own; the API never lists
 * another person's.
 */

/** The platforms a gemie can be linked to. */
export const GEMIE_ACCOUNT_PLATFORMS = ['whatsapp', 'telegram'] as const;
export type GemieAccountPlatform = (typeof GEMIE_ACCOUNT_PLATFORMS)[number];

export const GEMIE_ACCOUNT_STATUSES = [
  'connecting',
  'connected',
  'disconnected',
  'error',
  'expired',
] as const;
export type GemieAccountStatus = (typeof GEMIE_ACCOUNT_STATUSES)[number];

/** One account, as `GET /agents/:id/accounts` lists it. */
export interface GemieAccount {
  _id: string;
  platform: GemieAccountPlatform;
  accountId: string;
  displayName?: string | null;
  phoneNumber?: string | null;
  status: GemieAccountStatus;
  oxyTaskState?: 'active' | 'reauth_required';
}

/** What a link answers while the provider waits for its QR code to be scanned. */
export interface GemieAccountLink {
  accountId: string;
  qr: string | null;
}

/**
 * The caller's accounts on this gemie. An account whose Oxy task lapsed is renewed on the way
 * (the provider link is kept; the person who opened the editor is the verified requester), and a
 * renewal that fails leaves it typed inactive for the next visit to retry.
 */
export function useGemieAccounts(agentId: string) {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: queryKeys.agents.accounts(agentId),
    queryFn: async (): Promise<GemieAccount[]> => {
      try {
        const response = await apiClient.get<{ accounts: GemieAccount[] }>(
          API_ROUTES.agents.accounts(agentId),
        );
        const accounts = response.data.accounts ?? [];
        await Promise.all(
          accounts
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
        return accounts;
      } catch (error) {
        // No integrations service here: nothing can be linked, which is not an error to show.
        if (errorStatus(error) === 503) return [];
        throw error;
      }
    },
    enabled: isAuthenticated && agentId !== '',
  });
}

/**
 * The QR code of an account being linked, refreshed while it waits (WhatsApp rotates its code).
 * Once the provider reports the session connected, the account's stored status is synced and the
 * list re-read, and `connected` turns true.
 */
export function useGemieAccountQr(agentId: string, link: GemieAccountLink | null) {
  const queryClient = useQueryClient();
  const accountId = link?.accountId ?? '';
  return useQuery({
    queryKey: queryKeys.agents.accountQr(agentId, accountId),
    queryFn: async (): Promise<{ qr: string | null; connected: boolean }> => {
      const response = await apiClient.get<{ status?: string; qr?: string | null }>(
        `${API_ROUTES.agents.account(agentId, accountId)}/qr`,
      );
      const connected = response.data.status === 'connected';
      if (connected) {
        await apiClient.get(`${API_ROUTES.agents.account(agentId, accountId)}/status`);
        await queryClient.invalidateQueries({ queryKey: queryKeys.agents.accounts(agentId) });
      }
      return { qr: response.data.qr ?? null, connected };
    },
    enabled: link !== null,
    initialData: link ? { qr: link.qr, connected: false } : undefined,
    initialDataUpdatedAt: 0,
    refetchInterval: (query) => (query.state.data?.connected ? false : 4000),
  });
}

/** Linking a new account, and removing one (its session ends and its task is revoked). */
export function useGemieAccountMutations(agentId: string) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.accounts(agentId) });

  const link = useMutation({
    mutationFn: async (platform: GemieAccountPlatform): Promise<GemieAccountLink> => {
      const response = await apiClient.post<{ accountId: string; qr?: string | null }>(
        API_ROUTES.agents.accounts(agentId),
        { platform },
      );
      return { accountId: response.data.accountId, qr: response.data.qr ?? null };
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (accountId: string) => {
      await apiClient.delete(API_ROUTES.agents.account(agentId, accountId));
    },
    onSuccess: invalidate,
  });

  return { link, remove };
}
