import type { GemieThreadAddress } from '@gemies/sdk/runtime';
import { AiChatMobileHeader } from '@oxy.so/bloom/ai-chat';
import { View } from 'react-native';
import { agentDisplayName } from '@/features/agents/model/identity';
import { useAgentThread } from '@/features/agents/runtime/use-agent-thread';
import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { ChatWorkspace } from '@/features/chat/ui/chat-workspace';
import { ConversationScreen } from '@/features/chat/ui/conversation-screen';
import { useTranslation } from '@/shared/i18n/use-translation';
import { EmptyState } from '@/shared/ui/empty-state';
import { agentHandle } from '@/shared/routing/agent-address';

/**
 * The permanent thread with a gemie, wherever its address put it: `/@pepe` (its handle) or
 * `/agents/<id>` (a gemie with no handle: no Oxy account, ADR 0036). The address is the only thing
 * the two routes differ in, so the screen is one.
 *
 * ## The thread
 *
 * The conversation LIVES here. This screen does not hand off to `/c/:id`: the pair (person, agent)
 * has one thread, and its address is this page, so coming back tomorrow is the same page rather
 * than a new chat in the sidebar.
 *
 * Everything below the identity is the ordinary conversation screen, which is why this file is
 * short — see `src/features/chat/ui/conversation-screen.tsx`.
 */
export function AgentThreadScreen({
  thread,
  threadId,
  resolving = false,
}: {
  thread: GemieThreadAddress;
  /** One stretch of the thread (`?threadId=`), when the link named one. */
  threadId?: string;
  /**
   * The route is still finding out what its address is (whether `/@pepe` is a person's profile):
   * until it knows, a thread that is not found is not said to be.
   */
  resolving?: boolean;
}) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useAgentThread(thread, threadId);
  // The agent as the person's own list has it, for the first frame.
  const { data: mine } = useMyAgents();
  const known = mine?.find((agent) =>
    'handle' in thread ? agentHandle(agent) === thread.handle : agent._id === thread.gemieId,
  );

  /**
   * A gemie that does not exist and one this person cannot reach are ONE state, deliberately: the
   * API answers 404 for both, and this screen says the same thing about both. A distinct "you
   * don't have access" would confirm the gemie exists, which is what an unpublished gemie's owner
   * did not agree to.
   *
   * Every other error lands here too. That is not a compromise — a screen that distinguished "not
   * found" from "we couldn't ask" would leak the same fact whenever the second only ever happens
   * for one of them. Both inside the chat's own frame: this is a chat route, so no layout
   * container wraps it, and a phone still needs the menu to leave.
   */
  if (isError && !resolving) {
    return (
      <ChatWorkspace header={<AiChatMobileHeader title="Gemies" />}>
        <View className="flex-1 justify-center">
          <EmptyState title={t('agents.notFound')} />
        </View>
      </ChatWorkspace>
    );
  }

  if (isPending || data === undefined) {
    // The chat is drawn at once, as the agent the sidebar already knows, with the thread's skeleton
    // where the turns will be: nothing here waits on the lookup of the conversation.
    return (
      <ConversationScreen
        loading
        agentId={known?._id}
        agentName={known && agentDisplayName(known)}
      />
    );
  }

  /**
   * The name the header shows. `agentDisplayName` ends at the generic word "Agent", which is right
   * for a listing where nothing else is known about the row. Here the handle in the URL is what this
   * person followed, so a gemie whose Oxy account resolved nothing is still called what they
   * called it rather than being renamed to a noun.
   */
  const headerName =
    data.agent.name?.trim() ||
    data.agent.handle?.trim() ||
    ('handle' in thread ? thread.handle : agentDisplayName(data.agent));

  return (
    <ConversationScreen
      conversationId={data.conversationId}
      agentId={data.agent._id}
      agentName={headerName}
      /**
       * The address is what makes this screen a THREAD rather than one conversation: it is what the
       * history is paged from, and what is re-read when a new stretch begins. Without it the screen
       * shows the active conversation and nothing behind it. A thread asked for by one of its
       * stretches is that stretch alone.
       */
      thread={data.threadId ? undefined : thread}
    />
  );
}
