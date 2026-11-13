import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import apiClient from '@/shared/api/client';
import { errorStatus } from '@/shared/api/error-utils';
import { API_ROUTES } from '@/shared/api/routes';

interface ActivityGridDay {
  date: string; // "YYYY-MM-DD"
  count: number;
}

export interface ActivityGridData {
  grid: ActivityGridDay[];
  totalSessions: number;
  maxCount: number;
}

/**
 * An agent's activity per day. Asked once the session is known, as the agent's card is
 * (`useAgent`): a draft's activity is its editors', and asked anonymously it is a 404. A 404 is an
 * answer, not a failure to retry.
 */
export function useActivityGrid(agentId: string, weeks: number = 52) {
  const { isPrivateApiPending } = useOxy();
  return useQuery<ActivityGridData>({
    queryKey: ['agent-activity-grid', agentId, weeks],
    queryFn: async () => {
      const res = await apiClient.get(API_ROUTES.agents.activityGrid(agentId), {
        params: { weeks },
      });
      return res.data;
    },
    staleTime: 1000 * 60 * 5,
    retry: (failureCount, error) => errorStatus(error) !== 404 && failureCount < 2,
    enabled: !!agentId && !isPrivateApiPending,
  });
}
