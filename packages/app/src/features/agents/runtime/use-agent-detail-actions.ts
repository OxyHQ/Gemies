import { agentChatRoute, agentThreadHref } from '@/shared/routing/agent-address';
import { shareAgent } from '@/features/agents/runtime/share-agent';
import { useSetAgentStatus } from '@/features/agents/runtime/use-agent-thread-actions';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

/** What a share ended in, said to the person: a copied link, or a gemie with no page to share. */
export function useAnswerShare() {
  const { t } = useTranslation();
  return useCallback(
    async (agent: Agent) => {
      try {
        const outcome = await shareAgent(agent);
        if (outcome === 'copied') toast.success(t('agents.linkCopied'));
        if (outcome === 'unavailable') toast.error(t('agents.chatUnavailable'));
      } catch {
        toast.error(t('agents.shareFailed'));
      }
    },
    [t],
  );
}

/**
 * What the agent screen's buttons do: open a thread, share the agent, pause or resume it.
 *
 * Every write goes through a mutation in `use-agent-thread-actions.ts`; what
 * lives here is the answer to each outcome — where to navigate, what to toast.
 */
export function useAgentDetailActions(agent: Agent) {
  const router = useRouter();
  const { t } = useTranslation();
  const setStatus = useSetAgentStatus();
  const answerShare = useAnswerShare();

  /** The thread with this agent, addressed by its handle. */
  const openThread = useCallback(
    (handle: string, threadId: string) => {
      router.push(agentThreadHref(handle, threadId));
    },
    [router],
  );

  /**
   * Open the thread with this agent. It does not START one.
   *
   * The thread is the agent's handle: `/@handle` opens it where it left off, and the API begins its
   * first conversation only when the two have never spoken (`GET /agents/thread/:username`).
   * Without a handle the thread has no address; saying so is better than navigating to `/@`, which
   * would sit on a loading screen that never resolves.
   */
  const handleChat = useCallback(() => {
    const route = agentChatRoute(agent);
    if (route === null) {
      toast.error(t('agents.chatUnavailable'));
      return;
    }
    router.push(route);
  }, [agent, router, t]);

  const handleShare = () => answerShare(agent);

  const handleStatusToggle = async (newStatus: 'active' | 'idle') => {
    try {
      await setStatus.mutateAsync({ agentId: agent._id, status: newStatus });
    } catch {
      toast.error(t('agents.statusUpdateFailed'));
    }
  };

  return { handleChat, handleShare, handleStatusToggle, openThread };
}
