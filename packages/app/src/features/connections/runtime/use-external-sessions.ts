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

/**
 * Whether `folder` is inside one of `roots`, the folders the agent's computer allows (ADR 0043 §3).
 * Only a hint to spare a round trip: the computer decides, and resolves symlinks, which this cannot.
 * A path it cannot judge (`~/…`, a drive path, no roots known) passes.
 */
export function isAllowedFolder(folder: string, roots: readonly string[]): boolean {
  const path = folder.trim().replace(/\/+$/, '');
  if (roots.length === 0 || !path.startsWith('/')) return true;
  const absolute = roots
    .map((root) => root.replace(/\/+$/, ''))
    .filter((root) => root.startsWith('/'));
  // A root the app cannot compare (`~/work`) means it cannot rule anything out.
  if (absolute.length < roots.length) return true;
  return absolute.some((root) => path === root || path.startsWith(`${root}/`));
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

  // The folders its computer allows. It answers live, so an offline computer, or an older daemon
  // that does not say, leaves the list empty and the dialog judges nothing.
  const computer = useQuery({
    queryKey: queryKeys.agents.externalComputer(agentId),
    enabled: isAuthenticated,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () =>
      (await apiClient.get<{ roots?: string[] }>(API_ROUTES.agents.external.computer(agentId))).data
        .roots ?? EMPTY,
  });

  const open = useCallback(
    async (cwd: string): Promise<string> => {
      const folder = cwd.trim();
      if (!isSessionFolder(folder)) throw new Error('invalid_folder');
      const conversation = await createConversation.run({ agentId });
      if (!conversation) throw new Error('conversation_not_created');
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
    /** The folders its computer allows sessions in; empty when it cannot say. */
    allowedFolders: computer.data ?? EMPTY,
    loadingFolders: isAuthenticated && folders.isPending && !folders.isError,
    open,
    opening: createConversation.isPending,
  };
}
