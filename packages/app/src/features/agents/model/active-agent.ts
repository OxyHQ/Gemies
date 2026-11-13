import type { Agent } from '@/shared/contracts/agents';
import { gemieOfThreadPath } from '@/shared/routing/agent-address';

/**
 * The agent whose thread or conversation the path shows, if any: `/@handle` is the agent's
 * permanent thread (`/agents/<id>` for one with no handle), and `/c/:id` is a chat that belongs to
 * an agent. Anything else shows no agent, so the app keeps its own theme there.
 */
export function activeAgentFor({
  pathname,
  agents,
  conversations,
}: {
  pathname: string;
  agents: readonly Agent[];
  conversations: readonly { id: string; agentId?: string | null }[];
}): Agent | undefined {
  const threadGemie = gemieOfThreadPath(pathname, agents);
  if (threadGemie !== undefined) return threadGemie;
  const conversationId = /^\/c\/([^/]+)/.exec(pathname)?.[1];
  if (conversationId !== undefined) {
    const agentId = conversations.find(
      (conversation) => conversation.id === conversationId,
    )?.agentId;
    return agentId ? agents.find((agent) => agent._id === agentId) : undefined;
  }
  return undefined;
}
