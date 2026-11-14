/**
 * A gemie writes to another (ADR 0041): the messaging primitive, the same act as a person sending a
 * message, from a gemie's live turn in its chat with the person.
 *
 * It stores the message in the conversation the two gemies have for this person (opening it the
 * first time), mints the Oxy task each one's unattended turns of the chain will act under while the
 * person's bearer is here, and queues the answer. It never waits for the answer: the chain goes on in
 * the room's workers (`engine.ts`) and the answer comes back to the gemie that wrote as a turn of its
 * own. Authorizing the recipient is the caller's (`lib/tools/send-message.ts`).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../../db/index.js';
import { openGemieConversation } from '../../../db/chat/gemieConversationRepository.js';
import type { AgentInfo } from '../../../domain/conversation.js';
import type { HydratedAgent } from '../../agent-identity.js';
import { gemieOxyAccountId } from '../../gemie-oxy-actor.js';
import { log } from '../../logger.js';
import { createOxyTask, revokeOxyTask } from '../../oxy-task-authority.js';
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

async function memberOf(
  agent: HydratedAgent,
  info: AgentInfo,
  input: { userId: string; accessToken: string | undefined; chainId: string },
): Promise<GemieMember> {
  // A gemie with no Oxy account (ADR 0036) acts as nobody there: it talks, with no Oxy task.
  const actorAccountId = gemieOxyAccountId(agent);
  if (actorAccountId === null || input.accessToken === undefined) return { info };
  try {
    const oxyTaskId = await createOxyTask({
      accessToken: input.accessToken,
      effectiveAccountId: input.userId,
      actorAccountId,
      origin: { kind: 'request', id: `gemies:${input.chainId}:${agent._id}` },
    });
    return { info, oxyTaskId };
  } catch (error: unknown) {
    // Less authority, never more: without a task its turns have no Oxy apps.
    log.agents.warn({ err: error, agentId: agent._id }, 'Could not mint a gemie chain task');
    return { info };
  }
}

export async function sendGemieMessage(input: {
  /** The person both gemies work for. */
  readonly userId: string;
  readonly from: { readonly agent: HydratedAgent; readonly info: AgentInfo };
  readonly to: { readonly agent: HydratedAgent; readonly info: AgentInfo };
  readonly text: string;
  /** The person's chat the writer is in: where it continues once the answer comes. */
  readonly originConversationId: string;
  readonly accessToken: string | undefined;
  readonly surfaceApplicationId: string | null;
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
  const stored = await deps.storeReply({
    userId,
    conversationId,
    clientMessageId: messageId,
    content: input.text,
    agentInfo: from.info,
  });
  await Promise.resolve(
    deps.publish({
      userId,
      conversationId,
      chainId,
      event: 'group.message',
      data: {
        message: {
          id: stored.id,
          role: 'assistant',
          content: input.text,
          agentInfo: from.info,
          seq: stored.seq,
          createdAt: stored.createdAt.toISOString(),
        },
      },
    }),
  ).catch((err: unknown) => log.general.warn({ err }, 'Could not publish a gemie message'));

  const authority = { userId, accessToken: input.accessToken, chainId };
  const [initiator, recipient] = await Promise.all([
    memberOf(from.agent, from.info, authority),
    memberOf(to.agent, to.info, authority),
  ]);
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
  };
  try {
    await enqueueGemieStep(step);
  } catch (error) {
    await Promise.allSettled(
      [initiator.oxyTaskId, recipient.oxyTaskId]
        .filter((id): id is string => id !== undefined)
        .map((id) => revokeOxyTask(id)),
    );
    throw error;
  }
  return { conversationId, messageId, chainId };
}
