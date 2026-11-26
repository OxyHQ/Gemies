import { useAnswer } from '@gemies/sdk/runtime';
import { type RecordView, skip } from '@oxy.so/bloom-data';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQueries } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { myAgents } from '@/shared/api/account-data';
import apiClient from '@/shared/api/client';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';

/**
 * The agents this person owns — the sidebar's own list, not the marketplace's.
 *
 * `useAgentCatalogue` reads `GET /agents`, which is the CATALOGUE:
 * everything published, by anybody, filtered by category and search. The
 * sidebar wants the opposite list — the ones this person made, published or
 * not — which is `GET /agents/me`, scoped by author in the query rather than
 * filtered afterwards.
 *
 * Their identities are resolved through the same batched Oxy lookup that fails
 * open, so `name`, `handle` and `color` are all nullable and every row renders
 * through the shared fallbacks.
 *
 * The array ARRIVES ordered — the agent last spoken to first, then by when each
 * was made — and the sidebar renders it in that order. `use-agent-row-preview`
 * keeps that true between loads; nothing else may sort it, because a second
 * order would only disagree with the one the next fetch brings.
 */
export function useMyAgents(): RecordView<Agent[]> {
  const { user, canUsePrivateApi } = useOxy();

  const view = useAnswer(myAgents, ...(canUsePrivateApi ? [apiClient] : [skip]));
  // This handshake is memory only. Each agent retries independently, without
  // blocking the sidebar or requiring another list refresh after an outage.
  const eligible =
    canUsePrivateApi && user?.id
      ? (view.value ?? []).filter(
          (agent) =>
            agent.ownerOxyAccountId === user.id &&
            agent.status === 'active' &&
            agent.scheduleInterval &&
            !agent.external,
        )
      : [];
  useQueries({
    queries: eligible.map((agent) => ({
      queryKey: queryKeys.agents.workAuthority(user?.id ?? '', agent._id),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await apiClient.post(`/agents/${encodeURIComponent(agent._id)}/work`, {}, { signal });
        return true;
      },
      gcTime: 0,
      staleTime: Infinity,
      retry: (attempt: number, error: unknown) => attempt < 2 && retryableActivation(error),
      refetchInterval: (query: { state: { status: string; error: unknown } }) =>
        query.state.status === 'error' && retryableActivation(query.state.error) ? 60_000 : false,
    })),
  });
  return view;
}

function retryableActivation(error: unknown): boolean {
  return !isAxiosError(error) || ![401, 403].includes(error.response?.status ?? 0);
}
