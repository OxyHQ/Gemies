import { useQueryClient } from '@tanstack/react-query';
import { useGemieRealtime, useRealtimeEvent, useRealtimeReset } from '@gemies/sdk/runtime';
import { useEffect } from 'react';
import type { RealtimeData } from '@gemies/sdk/realtime';
import type { CreditsInfo } from '@/features/billing/runtime/use-credits';
import { patchAgentRow } from '@/features/chat/runtime/use-agent-row-preview';
import { queryKeys } from '@/shared/api/query-keys';
import type { Agent } from '@/shared/contracts/agents';

/** The local runtimes list's key (`use-local-runtimes`). */
const LOCAL_RUNTIMES_KEY = ['local-runtimes'] as const;

/**
 * What the app keeps live from the account's realtime connection (`docs/realtime.mdx`) — the lists
 * that are the app's own. The conversations, their messages, reactions, rooms and "typing…" are
 * the SDK's and stay live by themselves. Mounted once, in the signed-in layout. Nothing here polls:
 * each event patches what it carries, and re-reads at most the one list it names.
 */
export function useAppRealtime(): void {
  const queryClient = useQueryClient();

  // A gemie's thread moved: its sidebar row shows the newest line and what is unread.
  useRealtimeEvent('conversation', (frame) => {
    const { conversation, thread } = frame.data as RealtimeData['conversation'];
    if (!conversation.agentId) return;
    patchAgentRow(queryClient, conversation.agentId, {
      lastMessage: conversation.lastMessage,
      lastMessageAt: conversation.updatedAt,
      unreadCount: thread.unreadCount,
    });
  });
  useRealtimeEvent('conversation.deleted', (frame) => {
    const { thread } = frame.data as RealtimeData['conversation.deleted'];
    if (!thread?.agentId) return;
    queryClient.setQueryData<Agent[]>(queryKeys.agents.mine, (current) =>
      current?.map((agent) =>
        agent._id === thread.agentId ? { ...agent, unreadCount: thread.unreadCount } : agent,
      ),
    );
  });

  // The person's gemies: made, edited (name, look, colour), deleted — on any device.
  useRealtimeEvent('gemies', () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.external, exact: true });
  });

  // An external agent's computer came online or went away (ADR 0030).
  useRealtimeEvent('presence', (frame) => {
    const { agentId, online } = frame.data as RealtimeData['presence'];
    queryClient.setQueryData<Agent[]>(queryKeys.agents.mine, (current) =>
      current?.map((agent) =>
        agent._id === agentId && agent.external
          ? { ...agent, external: { ...agent.external, online } }
          : agent,
      ),
    );
    queryClient.setQueryData<{ agentId: string; online: boolean }[]>(
      queryKeys.agents.external,
      (current) =>
        current?.map((agent) => (agent.agentId === agentId ? { ...agent, online } : agent)),
    );
  });

  // The balance, as the server settled it; the rest of the panel (the usage window) on focus.
  useRealtimeEvent('credits', (frame) => {
    const { credits } = frame.data as RealtimeData['credits'];
    // The query is keyed by account and session under `credits.info`: every one of them is this
    // account's.
    if (typeof credits === 'number') {
      queryClient.setQueriesData<CreditsInfo>({ queryKey: queryKeys.credits.info }, (old) =>
        old ? { ...old, credits } : old,
      );
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
  });

  useRealtimeEvent('notification', () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  });

  // A device offering its own model joined or left.
  useRealtimeEvent('runtimes', () => {
    void queryClient.invalidateQueries({ queryKey: LOCAL_RUNTIMES_KEY, exact: true });
  });

  // Back after a disconnection: the signals of the time away (presence, runtimes) are not
  // replayed, so the lists they keep are read again, once. The durable events catch up by
  // themselves (`rt:sync`).
  const realtime = useGemieRealtime();
  useEffect(() => {
    if (!realtime) return;
    let wasDown = false;
    return realtime.onStatus((connected) => {
      if (!connected) {
        wasDown = true;
        return;
      }
      if (!wasDown) return;
      wasDown = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.mine, exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.external, exact: true });
      void queryClient.invalidateQueries({ queryKey: LOCAL_RUNTIMES_KEY, exact: true });
    });
  }, [realtime, queryClient]);

  // Too far behind to catch up: read the app's own lists again, once.
  useRealtimeReset(() => {
    for (const queryKey of [
      queryKeys.agents.mine,
      queryKeys.agents.external,
      queryKeys.credits.info,
      ['notifications'],
      LOCAL_RUNTIMES_KEY,
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });
}
