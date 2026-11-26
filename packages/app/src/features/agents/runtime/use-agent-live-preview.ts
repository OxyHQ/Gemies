import { agentProfile, useGemieApi } from '@gemies/sdk/runtime';
import { useStore, withStore } from '@oxy.so/bloom-data';
import { useQueryClient } from '@tanstack/react-query';
import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { useMemo } from 'react';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';
import { refreshMyAgents, updateMyAgents } from '@/shared/api/account-data';

/** What of an agent the person sees all over the app and changes in the editor. */
export interface AgentLook {
  name?: string;
  tagline?: string;
  character?: AvatarCharacter;
  /** The account's colour, which paints the character and tints its chat. */
  color?: string;
}

/**
 * An edit of how an agent looks, shown EVERYWHERE the moment it is made.
 *
 * Every screen that draws an agent reads it from a record: the sidebar's rows from the person's
 * list (`myAgents`), an open chat's header from the agent's profile (the SDK's `agentProfile`), the
 * detail screen from the agent itself (a query).
 * The editor saves on a pause, and those queries only changed once the save had landed and they
 * had been read again, so a new avatar reached the editor at once and the rest of the app a second
 * or two later. Here the edit is written into the three as it is made, and the save (and the
 * read after it) only confirms it.
 *
 * Only entries already held are touched: an agent nobody has loaded has nothing to show
 * the edit on. A save that fails puts what the server holds back (`revert`).
 */
export function useAgentLivePreview(agentId: string) {
  const queryClient = useQueryClient();
  const store = useStore();
  const api = useGemieApi();
  return useMemo(() => {
    const merge = <T extends { name?: unknown; character?: unknown; color?: unknown }>(
      current: T,
      look: AgentLook,
      fields: ReadonlyArray<keyof AgentLook>,
    ): T => {
      const patch: Record<string, unknown> = {};
      for (const field of fields) if (look[field] !== undefined) patch[field] = look[field];
      return { ...current, ...patch };
    };
    /** Everything that shows the agent reads what the server holds again. */
    const reread = () => {
      withStore(store, () => {
        refreshMyAgents();
        agentProfile.invalidate(api, agentId);
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    };
    return {
      show(look: AgentLook) {
        withStore(store, () => {
          updateMyAgents((list) =>
            list.map((agent) =>
              agent._id === agentId
                ? merge(agent, look, ['name', 'tagline', 'character', 'color'])
                : agent,
            ),
          );
          // The profile has no tagline: its name and look are what the chat's header draws.
          agentProfile.entity.update(agentId, (held) =>
            held.value
              ? { ...held, value: merge(held.value, look, ['name', 'character', 'color']) }
              : undefined,
          );
        });
        queryClient.setQueryData<Agent>(queryKeys.agents.detail(agentId), (agent) =>
          agent ? merge(agent, look, ['name', 'tagline', 'character', 'color']) : agent,
        );
      },
      /** The save did not land: read what the server holds again. */
      revert: reread,
      /** The save landed: read it again, so every screen shows what the server stored. */
      reread,
    };
  }, [queryClient, store, api, agentId]);
}
