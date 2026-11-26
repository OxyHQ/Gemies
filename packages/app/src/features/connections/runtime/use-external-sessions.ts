import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';
import { queryKeys } from '@/shared/api/query-keys';
import { useCreateConversation } from '@gemies/sdk/runtime';
import { useOxy } from '@oxy.so/services/ui/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/**
 * Whether `path` names a folder the way the API accepts one (ADR 0043): absolute on the agent's
 * computer, so `/…`, `~`, `~/…` or a drive (`C:\…`, `D:/…`). The agent's own computer still decides
 * whether the folder exists and is allowed there; this only spares a round trip for an obvious typo.
 */
export function isSessionFolder(path: string): boolean {
  const value = path.trim();
  return value !== '' && value.length <= 1024 && /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(value);
}

const EMPTY: string[] = [];

/**
 * Sessions of an external agent, opened from the app (ADR 0043): the folders its sessions worked in
 * lately, and `open`, which starts a new conversation with it, tells Gemies which folder that
 * conversation works in, and returns the conversation's id.
 *
 * The conversation is made the way every new conversation with an agent is (`POST /conversations/new`),
 * so its id is the server's; the folder is registered for it before the first message.
 */
export function useExternalSessions(agentId: string) {
  const { isAuthenticated } = useOxy();
  const queryClient = useQueryClient();
  const createConversation = useCreateConversation();

  const folders = useQuery({
    queryKey: queryKeys.agents.externalFolders(agentId),
    enabled: isAuthenticated,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      (await apiClient.get<{ folders: string[] }>(API_ROUTES.agents.external.folders(agentId))).data
        .folders ?? EMPTY,
  });

  const open = useCallback(
    async (cwd: string): Promise<string> => {
      const folder = cwd.trim();
      if (!isSessionFolder(folder)) throw new Error('invalid_folder');
      const conversation = await createConversation.mutateAsync({ agentId });
      await apiClient.post(API_ROUTES.agents.external.sessions(agentId), {
        conversationId: conversation.id,
        cwd: folder,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.externalFolders(agentId) });
      return conversation.id;
    },
    [agentId, createConversation, queryClient],
  );

  return {
    folders: folders.data ?? EMPTY,
    loadingFolders: isAuthenticated && folders.isPending && !folders.isError,
    open,
    opening: createConversation.isPending,
  };
}
