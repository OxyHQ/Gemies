import { groupMembersOf } from '@/features/agents/model/group-members';
import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { ConversationScreen } from '@/features/chat/ui/conversation-screen';
import { GemieBetweenGemies } from '@gemies/sdk';
import { useConversation } from '@gemies/sdk/runtime';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { View } from 'react-native';

const ChatConversationPage = () => {
  const { id, agentId } = useLocalSearchParams<{ id: string; agentId?: string }>();
  const router = useRouter();
  // A group conversation has no lead: its members, read from the conversation and the person's
  // own agents, are what the chat draws. The chat waits for them (its skeleton) rather than
  // greeting as Alia for a moment.
  const { data: conversation } = useConversation(id);
  const { data: agents } = useMyAgents();
  const memberIds = conversation?.memberAgentIds;
  const group = useMemo(() => groupMembersOf(memberIds, agents), [memberIds, agents]);
  const waitingForMembers = memberIds !== undefined && memberIds.length > 0 && group === undefined;
  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)');
  }, [router]);

  // A conversation between the person's gemies (ADR 0041) is theirs: the person reads it, live,
  // and never writes in it, so it opens with no composer.
  if (conversation?.kind === 'gemies') {
    return (
      <View className="flex-1 bg-background">
        <GemieBetweenGemies conversationId={id} onBack={back} />
      </View>
    );
  }

  return (
    <ConversationScreen
      conversationId={id}
      agentId={agentId}
      group={group}
      loading={waitingForMembers && agents === undefined}
    />
  );
};

export default ChatConversationPage;
