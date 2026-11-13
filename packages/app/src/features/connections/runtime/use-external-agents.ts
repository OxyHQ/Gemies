import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

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

/** A single-use code and the text to paste into the agent. */
export interface PairingInvite {
  code: string;
  expiresAt: string;
  prompt: string;
}

const EMPTY: ExternalAgent[] = [];

export function useExternalAgents(locale: string) {
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const [invite, setInvite] = useState<PairingInvite | null>(null);
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

  /** Mints a code. Throws when the server refuses (the caller shows the toast). */
  const createInvite = useCallback(async () => {
    const response = await apiClient.post<PairingInvite>(API_ROUTES.agents.external.pair, {
      locale,
    });
    setInvite(response.data);
    return response.data;
  }, [locale]);

  const remove = useCallback(
    async (agentId: string) => {
      await apiClient.delete(API_ROUTES.agents.external.remove(agentId));
      queryClient.setQueryData<ExternalAgent[]>(queryKeys.agents.external, (current) =>
        (current ?? []).filter((agent) => agent.agentId !== agentId),
      );
      // The agent leaves the sidebar's list too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine });
    },
    [queryClient],
  );

  return { agents, loading, invite, createInvite, remove };
}
