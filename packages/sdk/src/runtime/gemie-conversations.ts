/**
 * Conversations between gemies (ADR 0041), as a chat with the person sees them.
 *
 * A gemie writes to another with `sendMessage`: the message goes into the conversation the two of
 * them have for this person, and the call's result names it (`conversationId`, both gemies, the
 * chain it started). The person's chat draws that call as a card — "Pepe is talking to Lumen…" —
 * that follows the chain live over the conversation's `room` frames on the realtime socket and opens the
 * whole conversation, read-only. Pure: the card and its hook are `GemieConversationCard`.
 */

import type { RoomEvent } from './room-events';
import type { Message, ToolInvocation } from './types';

/** The messaging primitive a gemie writes to another with (`lib/tools/send-message.ts`). */
export const SEND_MESSAGE_TOOL = 'sendMessage';

type Agent = NonNullable<Message['agentInfo']>;

/** What a `sendMessage` call says about the conversation it wrote in. */
export interface GemieConversationCall {
  /** The conversation between the two gemies; `null` until the call has a result, or if it failed. */
  readonly conversationId: string | null;
  /** The chain the message started, when the server named it: its events carry it. */
  readonly chainId: string | null;
  readonly from: Agent | null;
  readonly to: Agent | null;
  /** The call is still running: the message is being written. */
  readonly writing: boolean;
  /** Why it could not be sent, when it could not. */
  readonly error: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function agentOf(value: unknown): Agent | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.handle === 'string' ? { handle: value.handle } : {}),
    ...(typeof value.color === 'string' ? { color: value.color } : {}),
    ...(isObject(value.character) ? { character: value.character } : {}),
  } as Agent;
}

/** The conversation a `sendMessage` call wrote in, or `null` for any other call. */
export function gemieConversationOf(call: ToolInvocation): GemieConversationCall | null {
  if (call.toolName !== SEND_MESSAGE_TOOL) return null;
  const result = isObject(call.result) ? call.result : null;
  const error = typeof result?.error === 'string' ? result.error : null;
  const conversationId =
    error === null && typeof result?.conversationId === 'string' ? result.conversationId : null;
  return {
    conversationId,
    chainId: typeof result?.chainId === 'string' ? result.chainId : null,
    from: agentOf(result?.from),
    to: agentOf(result?.to),
    writing: call.state !== 'result',
    error,
  };
}

/** What the card knows of the conversation while it watches it. */
export interface GemieConversationLive {
  /** The chain is running: one of them is writing, or the other is about to answer. */
  readonly talking: boolean;
  /** Who is writing right now, if anybody. */
  readonly speaking: Agent | null;
  /** The last thing either of them said while the card watched. */
  readonly lastLine: string | null;
}

/**
 * What one event of the conversation does to what the card shows. Events of another conversation,
 * or of another chain when the card knows its own, change nothing (the same object comes back).
 */
export function foldGemieConversationEvent(
  live: GemieConversationLive,
  event: RoomEvent,
  conversationId: string,
  chainId: string | null,
): GemieConversationLive {
  if (event.conversationId !== conversationId || !isObject(event.data)) return live;
  if (chainId !== null && event.chainId !== undefined && event.chainId !== chainId) return live;
  const data = event.data;
  switch (event.event) {
    case 'alia.agent_start':
      return { ...live, talking: true, speaking: agentOf(data.agent) };
    case 'alia.agent_end':
      return live.speaking === null ? live : { ...live, speaking: null };
    case 'group.message': {
      const message = isObject(data.message) ? data.message : null;
      const content = typeof message?.content === 'string' ? message.content.trim() : '';
      return content === '' ? live : { ...live, talking: true, lastLine: content };
    }
    case 'group.idle':
      return { ...live, talking: false, speaking: null };
    default:
      return live;
  }
}
