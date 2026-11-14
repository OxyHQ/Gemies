/**
 * A conversation message as a client receives it: the ONE serializer of every client-facing read
 * of a conversation (`GET /conversations/:id`, a gemie thread's pages, the realtime `conversation`
 * frame's `appended`) and therefore of every conversation those read, the app's chats, a channel's
 * (a gemie bot's Telegram chat, a connected account), a group room and a gemie-to-gemie transcript.
 *
 * Built as an ALLOW-list over the stored row, field by field, never by passing the row or
 * `toStoredMessage` through. A stored row also carries what a client must not see: the person's
 * vote and an interrupted answer's offset (server bookkeeping no client reads back), and once
 * carried a channel's system prompt, stored as a message by the saver's full rewrite: the
 * Telegram conversation of a gemie bot served `{"role":"system","content":"The user is chatting
 * via telegram…"}` as its first message (2026-11-14). A field a future writer stores is left out
 * here until somebody decides a client needs it; `client-message.test.ts` pins the shape.
 *
 * - `role` is `user` or `assistant`; any other row (a `system` or `tool` row) is not a message of
 *   the conversation and is dropped.
 * - `content` is the words and the attachments the thread draws: a string, or only the `text`,
 *   `image_url` and `file` parts.
 * - `toolInvocations` is each call as the thread draws it (`clientToolInvocation`): its name,
 *   state, arguments and its result in the client's form (`lib/tools/result-truncation.ts`
 *   `clientToolResult`), the same form the live `alia.tool_result` frame carries.
 */

import type { MessageRow } from '../../db/chat/messageRepository.js';
import {
  type AgentInfo,
  isMessageRole,
  type MessageContentPart,
  type MessageRole,
} from '../../domain/conversation.js';
import { clientToolResult } from '../tools/result-truncation.js';

/** The content parts a thread draws: words, an image, an attachment (`file`). */
const CLIENT_PART_TYPES: ReadonlySet<string> = new Set(['text', 'image_url', 'file']);

/** One tool call as the thread draws it. */
export interface ClientToolInvocation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly state: string;
  readonly args?: unknown;
  readonly result?: unknown;
}

export interface ClientMessage {
  /** The client's id for the message (`client_message_id`); the row's own key when it has none. */
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string | MessageContentPart[];
  readonly toolInvocations?: ClientToolInvocation[];
  /** The emoji the person left on it, and the revision a reaction is sent against. */
  readonly reactions?: string[];
  readonly reactionRevision: number;
  readonly agentInfo?: AgentInfo;
  readonly seq?: number;
  readonly createdAt: Date;
}

/**
 * The content a client is shown: a string as is, or the parts the thread draws. An unknown part
 * type (`reasoning`, a future one) is left out.
 */
export function clientContent(
  content: unknown,
  partTypes: ReadonlySet<string> = CLIENT_PART_TYPES,
): string | MessageContentPart[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(
    (part): part is MessageContentPart =>
      part !== null &&
      typeof part === 'object' &&
      typeof (part as { type?: unknown }).type === 'string' &&
      partTypes.has((part as { type: string }).type),
  );
}

/** One stored tool call as the thread draws it; `null` for an entry that is not a call. */
export function clientToolInvocation(value: unknown): ClientToolInvocation | null {
  if (value === null || typeof value !== 'object') return null;
  const call = value as Record<string, unknown>;
  if (typeof call.toolCallId !== 'string' || typeof call.toolName !== 'string') return null;
  const result = call.result === undefined ? undefined : clientToolResult(call.result);
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    state: typeof call.state === 'string' ? call.state : 'call',
    ...(call.args === undefined ? {} : { args: call.args }),
    ...(result === undefined ? {} : { result }),
  };
}

/** A stored row as a client receives it, or `null` when it is not a message of the conversation. */
export function toClientMessage(row: MessageRow): ClientMessage | null {
  if (!isMessageRole(row.role)) return null;
  const toolInvocations = Array.isArray(row.toolInvocations)
    ? row.toolInvocations.flatMap((call) => clientToolInvocation(call) ?? [])
    : [];
  return {
    id: row.clientMessageId ?? row.id,
    role: row.role,
    content: clientContent(row.content),
    ...(toolInvocations.length > 0 ? { toolInvocations } : {}),
    ...(Array.isArray(row.reactions) && row.reactions.length > 0
      ? { reactions: row.reactions.filter((emoji): emoji is string => typeof emoji === 'string') }
      : {}),
    reactionRevision: row.reactionRevision ?? 0,
    ...(row.agentInfoId === null
      ? {}
      : {
          agentInfo: {
            id: row.agentInfoId,
            name: row.agentInfoName ?? '',
            color: row.agentInfoColor,
            character: row.agentInfoCharacter,
            handle: row.agentInfoHandle ?? '',
          },
        }),
    ...(row.seq === null ? {} : { seq: row.seq }),
    createdAt: row.createdAt,
  };
}

/** A conversation's stored rows as a client receives them, in order. */
export function toClientMessages(rows: readonly MessageRow[]): ClientMessage[] {
  return rows.flatMap((row) => toClientMessage(row) ?? []);
}
