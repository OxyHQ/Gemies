import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

type ExternalCli = 'claude' | 'codex' | 'opencode';

/** One coding-agent CLI the person connected, and whether its computer is reachable right now. */
export interface ExternalAgent {
  agentId: string;
  cli: ExternalCli;
  hostName: string;
  online: boolean;
  createdAt: string;
  lastConnectedAt: string | null;
}

/**
 * A single-use code and the text to paste into the agent. The code is the whole authorisation: the
 * agent that runs it signs in to nothing (ADR 0038). `agentId` is set when it reconnects that agent.
 */
export interface PairingInvite {
  code: string;
  expiresAt: string;
  prompt: string;
  agentId?: string;
}

const EMPTY: ExternalAgent[] = [];

export function useExternalAgents(locale: string) {
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const [invite, setInvite] = useState<PairingInvite | null>(null);
  const [inviteExpired, setInviteExpired] = useState(false);
  /**
   * Read when the section opens and when the tab comes back, never on a timer: it polled every 6 s
   * while open. Pairing shows "Connected" through the same seam realtime will use, an
   * `external-agents:presence` socket event invalidating `queryKeys.agents.external`; until then
   * the section's own actions (pair, remove) and focus refresh it.
   */
  const query = useQuery({
    queryKey: queryKeys.agents.external,
    enabled: isAuthenticated,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      (await apiClient.get<{ agents: ExternalAgent[] }>(API_ROUTES.agents.external.list)).data
        .agents ?? [],
  });
  const agents = query.data ?? EMPTY;
  const loading = isAuthenticated && query.isPending && !query.isError;

  // The code stops working at its deadline; the section says so and offers a new one.
  useEffect(() => {
    if (!invite) return;
    const left = Date.parse(invite.expiresAt) - Date.now();
    setInviteExpired(left <= 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setInviteExpired(true), left);
    return () => clearTimeout(timer);
  }, [invite]);

  /**
   * Mints a code: for a new agent, or to reconnect `agentId` (a new machine, a lost credential).
   * Throws when the server refuses (the caller shows the toast).
   */
  const createInvite = useCallback(
    async (agentId?: string) => {
      const response = await apiClient.post<Omit<PairingInvite, 'agentId'>>(
        API_ROUTES.agents.external.pair,
        agentId ? { locale, agentId } : { locale },
      );
      const created: PairingInvite = agentId ? { ...response.data, agentId } : response.data;
      setInvite(created);
      return created;
    },
    [locale],
  );

  const remove = useCallback(
    async (agentId: string) => {
      await apiClient.delete(API_ROUTES.agents.external.remove(agentId));
      queryClient.setQueryData<ExternalAgent[]>(queryKeys.agents.external, (current) =>
        (current ?? []).filter((agent) => agent.agentId !== agentId),
      );
      // A reconnect code for it would reconnect nothing.
      setInvite((current) => (current?.agentId === agentId ? null : current));
      // The agent leaves the sidebar's list too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine });
    },
    [queryClient],
  );

  return { agents, loading, invite, inviteExpired, createInvite, remove };
}
