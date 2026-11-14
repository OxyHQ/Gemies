/**
 * A gemie writes to another (ADR 0042): the messaging primitive, the same act as a person sending a
 * message, from a gemie's live turn in its chat with the person.
 *
 * It stores the message in the conversation the two gemies have for this person (opening it the
 * first time) and queues the answer; each gemie's turns of the chain act for the person on Gemies'
 * own first-party authority (oxy ADR 0066). It never waits for the answer: the chain goes on in
 * the room's workers (`engine.ts`) and the answer comes back to the gemie that wrote as a turn of its
 * own. Authorizing the recipient is the caller's (`lib/tools/send-message.ts`).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../../db/index.js';
import { openGemieConversation } from '../../../db/chat/gemieConversationRepository.js';
import type { AgentInfo } from '../../../domain/conversation.js';
import type { HydratedAgent } from '../../agent-identity.js';
import { roomRuntime } from '../room/runtime.js';
import type { GemieMember, GemieStepData } from './engine.js';
import { gemieMessageIdOf } from './policy.js';
import { enqueueGemieStep } from './queue.js';

export interface SentGemieMessage {
  readonly conversationId: string;
  readonly messageId: string;
  readonly chainId: string;
}

/** A gemie as a message carries it. */
export function gemieInfo(agent: HydratedAgent, name: string): AgentInfo {
  return {
    id: agent._id,
    name,
    handle: agent.handle ?? '',
    color: agent.color,
    character: agent.character,
  };
}

export async function sendGemieMessage(input: {
  /** The person both gemies work for. */
  readonly userId: string;
  readonly from: { readonly agent: HydratedAgent; readonly info: AgentInfo };
  readonly to: { readonly agent: HydratedAgent; readonly info: AgentInfo };
  readonly text: string;
  /** The person's chat the writer is in: where it continues once the answer comes. */
  readonly originConversationId: string;
  readonly surfaceApplicationId: string | null;
  /** `false`: the person turned personalization off for the turn that writes; kept on the chain. */
  readonly personalization?: false;
}): Promise<SentGemieMessage> {
  const { userId, from, to } = input;
  const { conversationId } = await openGemieConversation(getDb(), {
    oxyUserId: userId,
    fromAgentId: from.info.id,
    toAgentId: to.info.id,
    title: `${from.info.name} · ${to.info.name}`,
  });
  const chainId = randomUUID();
  const messageId = gemieMessageIdOf(chainId, 0);
  const { deps } = roomRuntime();
  await deps.storeReply({
    userId,
    conversationId,
    clientMessageId: messageId,
    content: input.text,
    agentInfo: from.info,
  });
  // It reaches the person's surfaces as every stored message does: the realtime `conversation`
  // frame the store publishes, serialized by `toClientMessages`.

  const initiator: GemieMember = { info: from.info };
  const recipient: GemieMember = { info: to.info };
  const step: GemieStepData = {
    kind: 'gemies',
    phase: 'reply',
    userId,
    conversationId,
    originConversationId: input.originConversationId,
    chainId,
    triggerId: messageId,
    initiator,
    recipient,
    turn: 1,
    messages: 1,
    tokens: 0,
    surfaceApplicationId: input.surfaceApplicationId,
    ...(input.personalization === false ? { personalization: false as const } : {}),
  };
  await enqueueGemieStep(step);
  return { conversationId, messageId, chainId };
}
