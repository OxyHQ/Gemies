import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import type { AiChatThreadHandle } from '@oxy.so/bloom/ai-chat';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { BubblesProvider } from '../lib/bubbles';
import { useLabels } from '../lib/labels';
import { type GemieChatParticipants, participantOf } from '../lib/participants';
import { useConversation } from '../runtime/conversations';
import { createRoomLedger } from '../runtime/room-events';
import type { Message } from '../runtime/types';
import { useRoomEvents } from '../runtime/use-room-events';
import { GemieParticipants } from './GemieParticipants';
import { GemieThread } from './thread/GemieThread';

export interface GemieBetweenGemiesProps {
  /** A conversation between gemies (`kind: 'gemies'`, ADR 0042). */
  conversationId: string;
  /** Back to wherever it was opened from. */
  onBack: () => void;
}

type Agent = NonNullable<Message['agentInfo']>;

/** Who talks in it: the two gemies the server names, or, before it answers, whoever spoke. */
function membersOf(members: readonly Agent[] | undefined, messages: readonly Message[]): Agent[] {
  if (members && members.length > 0) return [...members];
  const seen = new Map<string, Agent>();
  for (const message of messages) {
    if (message.agentInfo && !seen.has(message.agentInfo.id)) {
      seen.set(message.agentInfo.id, message.agentInfo);
    }
  }
  return [...seen.values()];
}

/**
 * A conversation between gemies, read-only, in the same thread the person reads their own
 * conversations in: every turn under its gemie's name and avatar, its tool steps and thought
 * panel where it has them, the time it was said. While the gemies are still talking it streams,
 * through the conversation's `room` frames on the realtime socket, exactly as a group room does. There is no
 * composer: the person reads it and never writes in it (the API refuses a turn there).
 *
 * The chat draws it over itself when its card is pressed; an app may also give it a screen of its
 * own (a route to the conversation), where it is the whole page.
 */
export function GemieBetweenGemies(props: GemieBetweenGemiesProps) {
  // Keyed, so another conversation starts with nothing of this one's: its messages, its ledger.
  return <ConversationBetweenGemies key={props.conversationId} {...props} />;
}

function ConversationBetweenGemies({ conversationId, onBack }: GemieBetweenGemiesProps) {
  const { t, back } = useLabels();
  const threadRef = useRef<AiChatThreadHandle | null>(null);
  const { value: data, isLoading, isFetching, refresh } = useConversation(conversationId);
  const [messages, setMessages] = useState<Message[]>([]);
  // Which live reply each room event draws, for as long as this conversation is open.
  const [ledger] = useState(createRoomLedger);

  // Opened, it is read fresh: the gemies may have said more since it was last loaded.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const read = data?.messages;
  useEffect(() => {
    if (read) setMessages(read);
  }, [read]);
  useRoomEvents(conversationId, ledger, setMessages);

  const participants = useMemo<GemieChatParticipants | null>(() => {
    const [first, ...rest] = membersOf(data?.members, messages).map(participantOf);
    return first === undefined
      ? null
      : { lead: { ...first, isAlia: false, starters: [] }, joined: rest };
  }, [data?.members, messages]);

  return (
    <View className="flex-1 bg-background" testID="gemie-conversation">
      <PageHeader
        leading={
          <Button.Group accessibilityLabel={back}>
            <Button
              iconOnly
              leadingIcon={RiArrowLeftLine}
              accessibilityLabel={back}
              onPress={onBack}
            />
          </Button.Group>
        }
        title={participants ? <GemieParticipants participants={participants} /> : undefined}
        titleAlign="center"
        scrim="none"
        sticky={false}
        safeArea={false}
      />
      <Text className="px-4 pb-2 text-center text-xs text-muted-foreground">
        {t('chat.betweenGemiesNotice')}
      </Text>
      <AgentAvatarProvider>
        <BubblesProvider value>
          <GemieThread
            messages={messages}
            conversationId={conversationId}
            isLoading={false}
            conversationLoading={isLoading || (isFetching && read === undefined)}
            threadRef={threadRef}
            readOnly
          />
        </BubblesProvider>
      </AgentAvatarProvider>
    </View>
  );
}
