import {
  agentChatRoute,
  agentThreadHref,
  gemieThreadAddress,
} from '@/shared/routing/agent-address';
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

  /** One stretch of the thread with this agent, at its address. */
  const openThread = useCallback(
    (threadId: string) => {
      router.push(agentThreadHref(gemieThreadAddress(agent), threadId));
    },
    [agent, router],
  );

  /**
   * Open the thread with this agent. It does not START one.
   *
   * The thread is the agent's address (`/@handle`, or `/agents/<id>` for one with no handle): it
   * opens where it left off, and the API begins its first conversation only when the two have never
   * spoken.
   */
  const handleChat = useCallback(() => {
    router.push(agentChatRoute(agent));
  }, [agent, router]);

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
