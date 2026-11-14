import { AgentStack } from '@oxy.so/bloom/agent-reply';
import { AiChatMessageLine } from '@oxy.so/bloom/ai-chat';
import { Card } from '@oxy.so/bloom/card';
import { TypingDots } from '@oxy.so/bloom/chat-indicators';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { Item } from '@oxy.so/bloom/item';
import { useRef, useState } from 'react';
import { useOpenGemieConversation } from '../../lib/gemie-conversation-opener';
import { useLabels } from '../../lib/labels';
import { agentCharacterOf } from '../../lib/participants';
import { useRealtimeEvent } from '../../realtime/react';
import type { RoomEvent } from '../../runtime/room-events';
import {
  type GemieConversationCall,
  type GemieConversationLive,
  foldGemieConversationEvent,
} from '../../runtime/gemie-conversations';

/** The card's size for the two gemies' avatars together: a list row's leading box. */
const STACK_SIZE = 36;

/**
 * Follows a conversation between gemies while the card is on screen, over the account's realtime
 * `room` frames: whether they are still talking, who is writing, and the last thing said.
 * `talking` starts as `startedLive` — the call was made in this session, so the chain is running —
 * and the conversation's own events move it from there; a card read from history waits for an
 * event before it says anyone is talking.
 */
function useGemieConversationLive(
  conversationId: string | null,
  chainId: string | null,
  startedLive: boolean,
): GemieConversationLive {
  const [live, setLive] = useState<GemieConversationLive>({
    talking: startedLive,
    speaking: null,
    lastLine: null,
  });
  useRealtimeEvent('room', (frame) => {
    if (conversationId === null) return;
    const event = frame.data as RoomEvent;
    setLive((current) => foldGemieConversationEvent(current, event, conversationId, chainId));
  });
  return live;
}

/**
 * The card a `sendMessage` call draws in the chat (ADR 0041): "Pepe is talking to Lumen…" while
 * the gemies talk, with who is writing and the last thing said, then "Pepe talked to Lumen".
 * Pressed, it opens their whole conversation, read-only. The result the gemie that wrote comes back
 * with is its own reply, under the card, when it has it.
 */
export function GemieConversationCard({
  call,
  startedLive,
}: {
  call: GemieConversationCall;
  /** Whether the call was made while this chat was open (its turn is the one streaming). */
  startedLive: boolean;
}) {
  const { t } = useLabels();
  const open = useOpenGemieConversation();
  // Read once: the turn that made the call ends long before the conversation does.
  const startedLiveRef = useRef(startedLive);
  const live = useGemieConversationLive(
    call.conversationId,
    call.chainId,
    startedLiveRef.current || call.writing,
  );
  const { from, to } = call;
  if (from === null || to === null || call.error !== null) return null;

  const names = { from: from.name, to: to.name };
  const talking = call.writing || live.talking;
  const title = talking ? t('chat.gemiesTalking', names) : t('chat.gemiesTalked', names);
  const subtitle =
    live.speaking !== null
      ? t('chat.gemieWriting', { name: live.speaking.name })
      : (live.lastLine ?? t('chat.gemiesOpen'));
  const conversationId = call.conversationId;
  const pressable = open !== null && conversationId !== null;

  return (
    <AiChatMessageLine block>
      <Card>
        <Item
          leading={
            <AgentStack
              size={STACK_SIZE}
              agents={[from, to].map((agent) => ({
                id: agent.id,
                name: agent.name,
                avatar: agentCharacterOf(agent),
              }))}
            />
          }
          title={title}
          subtitle={subtitle}
          // The last thing said is a glimpse; the whole of it is one press away.
          subtitleNumberOfLines={1}
          trailing={talking ? <TypingDots /> : pressable ? <RiArrowRightSLine size="sm" /> : null}
          {...(pressable
            ? {
                accessibilityRole: 'button' as const,
                accessibilityLabel: `${title}. ${t('chat.gemiesOpen')}`,
                onPress: () => open(conversationId),
              }
            : {})}
        />
      </Card>
    </AiChatMessageLine>
  );
}
