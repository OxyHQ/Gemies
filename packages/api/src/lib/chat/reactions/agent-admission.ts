/** Keep the saver's admitted identities on the same message objects used by final persistence. */
import { usableMessageId } from '../../../domain/conversation.js';
import { randomUUID } from 'node:crypto';
import { saveConversation } from '../../conversation-saver.js';
import type { ChatMessage } from '../../message-converter.js';

export async function admitAgentReactionMessages(input: {
  userId: string;
  conversationId: string;
  agentId: string;
  messages: ChatMessage[];
  originApp?: string;
}) {
  // Name only the current person turn before admission. The canonical saver recovers historical
  // IDs from stored messages; minting fresh IDs for that history would discard its feedback.
  // The new turn needs its own identity even when it repeats an earlier message verbatim.
  const trigger = [...input.messages].reverse().find((message) => message.role === 'user');
  if (trigger && trigger.content !== undefined && usableMessageId(trigger.id) === undefined)
    trigger.id = randomUUID();
  await saveConversation({ ...input, assistantResponse: '', omitLeadReply: true });
}
