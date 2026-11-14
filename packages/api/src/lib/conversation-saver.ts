/**
 * Conversation Saver
 * Shared utility for extracting titles and persisting conversations.
 * Used by both the internal chat endpoint and the v1/chat-completions endpoint.
 */

import { generateText } from 'ai';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { turnContentText } from '@gemies/server/internal';
import { getDb, type Executor } from '../db/index.js';
import {
  findConversation,
  updateConversationTitle,
  upsertConversation,
} from '../db/chat/conversationRepository.js';
import {
  countMessages,
  countMessagesInConversation,
  existingClientMessageIds,
  rewriteMessages,
  findLastMessage,
  insertMessages,
  toStoredMessage,
  type MessageRow,
  type NewMessage,
} from '../db/chat/messageRepository.js';
import {
  channelReplyMessageId,
  isAgentWrittenMessageId,
  isMessageRole,
  usableMessageId,
  type AgentInfo,
  type AgentMessage,
  type ConversationSource,
  type MessageContent,
  type MessageRole,
  type ToolInvocation,
} from '../domain/conversation.js';
import { resolveUtilityModel, getAIModel } from './chat-core.js';
import { log } from './logger.js';
import { publishConversation, type ConversationChange } from './realtime/conversations.js';

// Known translations of "TITLE" that LLMs may produce
const TAG = String.raw`ALIA_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;
const TITLE_EXTRACT_RE = new RegExp(
  String.raw`\[(${TAG})\](.*?)\[\/\1\]|<(${TAG})>(.*?)<\/\3>`,
  'i',
);
const TITLE_STRIP_RE = new RegExp(String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi');

/** The shape callers actually pass (a subset of ChatMessage / stored message fields). */
interface InputMessage {
  role: string;
  content?: MessageContent;
  toolInvocations?: ToolInvocation[];
  agentInfo?: AgentInfo;
  id?: string;
  /** The id is new, drawn here for a message that came without one: nothing was left on it yet. */
  minted?: true;
}

/** Extract or generate a conversation title from the AI response, with fallbacks. */
function extractConversationTitle(response: string, messages: InputMessage[]): string {
  const m = response.match(TITLE_EXTRACT_RE);
  if (m) return (m[2] || m[4]).trim();

  // Prefer the first user message (most descriptive of conversation topic)
  const firstUserMsg = messages.find((msg) => msg.role === 'user')?.content;
  if (typeof firstUserMsg === 'string' && firstUserMsg.length > 0) return firstUserMsg.slice(0, 60);

  // Fallback: first ~6 words of cleaned response
  const cleaned = response.replace(/\[.*?\]|<.*?>|[#*_`]/g, '').trim();
  if (cleaned.length >= 10) return cleaned.split(/\s+/).slice(0, 6).join(' ');

  return 'New chat';
}

/** Remove [TITLE]...[/TITLE] and <TITLE>...</TITLE> tags from content. */
function stripTitleTags(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').trim();
}

export interface SaveConversationParams {
  userId: string;
  conversationId: string;
  messages: InputMessage[];
  assistantResponse: string;
  /**
   * The id the client drew this turn's reply under — the request's
   * `assistantMessageId`. The reply is stored under it, and so are the agent
   * answers that came with it ({@link agentMessageId}). Absent, they are named
   * by position like any other message the client did not name.
   */
  assistantMessageId?: string;
  toolInvocations?: ToolInvocation[];
  source?: ConversationSource;
  /** The gemie the conversation belongs to, if this turn creates it: the turn's own. */
  agentId: string;
  /** The embedding app (`host.app`); it labels the conversation only if this turn creates it. */
  originApp?: string;
  /** The consulted agents' answers, each stored as its own message before the reply. */
  agentMessages?: AgentMessage[];
  /**
   * A group turn has no lead: every reply is a member's, in `agentMessages`. Set, the turn stores
   * no reply of its own (`assistantResponse` is ignored) and the conversation's last message is the
   * last member's.
   */
  omitLeadReply?: boolean;
  /**
   * The channel of a verified channel turn (a gemie bot's person, a connected account): the turn is
   * appended after what the conversation holds, never reconciled from the history it sent
   * ({@link appendChannelTurn}), and a conversation it creates is labelled with it.
   */
  channelSource?: ConversationSource;
}

/**
 * The id of the `index`-th consulted agent's answer (0-based, in the order of
 * its `alia.agent_start`) of a turn whose reply is `assistantMessageId`.
 *
 * Derived on both sides rather than sent, so a client that drew the answer
 * live and the conversation it reloads later name it the same way
 * (`docs/agent-embedding.md` §4).
 */
export function agentMessageId(assistantMessageId: string, index: number): string {
  return `${assistantMessageId}-agent-${index}`;
}

/** Two messages are equal for append purposes if role and content match. */
function sameMessage(a: { role: string; content: unknown }, b: InputMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content === b.content) return true;
  try {
    return JSON.stringify(a.content) === JSON.stringify(b.content);
  } catch {
    return false;
  }
}

/**
 * The one index whose violation means "a concurrent append claimed this seq".
 *
 * Named, not just "some unique fired": `isUniqueViolation(error)` alone cannot
 * tell this index from any other on the table, so a future one would quietly
 * start triggering the full-rewrite recovery for an unrelated reason. It is also
 * why the SQLSTATE is read with `@oxy.so/db`'s helper rather than off
 * `error.code` — drizzle wraps the driver failure, so the code lives on `cause`
 * and a direct read matches nothing.
 */
const APPEND_SEQ_INDEX = 'messages_oxy_user_conversation_seq_key';

/**
 * The index that stores a message once per thread: a writer that appends a message already stored
 * (a channel's retried delivery, a concurrent save of the same turn) collides on it.
 */
const CLIENT_MESSAGE_INDEX = 'messages_oxy_user_conversation_client_message_key';

/** A conflict that a fresh read of the thread resolves: a seq or a message another writer took. */
function isAppendConflict(err: unknown): boolean {
  return isUniqueViolation(err, APPEND_SEQ_INDEX) || isUniqueViolation(err, CLIENT_MESSAGE_INDEX);
}

/**
 * Save or update a conversation in the database.
 * Handles title extraction, tag stripping, and message assembly.
 *
 * Messages are stored append-only: the common case (client resent the exact
 * stored history plus a new turn) inserts only the delta, keyed by a monotonic
 * `seq`. Any divergence, legacy (seq-less) history, or append race falls back to
 * a full delete + reinsert so storage always converges on the client's view.
 */
export async function saveConversation(params: SaveConversationParams): Promise<void> {
  const change = await storeConversation(params);
  // After the write committed: the person's other surfaces see the turn (`docs/realtime.mdx`).
  void publishConversation(params.userId, params.conversationId, change);
}

async function storeConversation(params: SaveConversationParams): Promise<ConversationChange> {
  const {
    userId,
    conversationId,
    messages,
    assistantResponse,
    toolInvocations,
    source,
    agentId,
    originApp,
    agentMessages,
    omitLeadReply = false,
    channelSource,
  } = params;

  /**
   * Every message keeps the id the client sent with it.
   *
   * It used to keep only an agent-outreach mark and drop the rest, so a turn
   * was stored as `msg-<seq>` while the client that had just drawn it held its
   * own ids — and the vote and read-aloud routes, which find a message by the
   * client's id, answered 404 for every reply of the session until a reload.
   */
  const clientHistory = messages
    // A conversation holds what its person and its gemie said. A system message is the prompt of
    // the turn (a channel's "The user is chatting via telegram…", an embedding app's context):
    // the request's context, never a message of the conversation. Stored, it was served to every
    // client as the conversation's first message (2026-11-14).
    .filter((m) => m != null && isMessageRole(m.role) && m.content !== undefined)
    .map((m) => {
      const id = usableMessageId(m.id);
      return {
        role: m.role,
        content: m.content,
        toolInvocations: m.toolInvocations,
        ...(id === undefined ? {} : { id }),
        // An agent-written message keeps its attribution when the client echoes
        // it back, so the next rewrite still recognises it.
        ...(isAgentWrittenMessageId(id) ? { agentInfo: m.agentInfo } : {}),
      };
    });

  // A channel turn answers its person's last message, and its reply is named after it: that is how
  // a retried delivery of the message knows it was answered (`channelReplyMessageId`).
  const channelMessage = channelSource
    ? [...clientHistory].reverse().find((message) => message.role === 'user')
    : undefined;
  const assistantMessageId =
    usableMessageId(params.assistantMessageId) ??
    (channelMessage?.id === undefined ? undefined : channelReplyMessageId(channelMessage.id));

  const turnTail: InputMessage[] = [
    // Insert agent messages before the final assistant response
    ...(agentMessages || []).map((am, index) => ({
      role: am.role,
      content: am.content,
      agentInfo: am.agentInfo,
      ...(am.toolInvocations && am.toolInvocations.length > 0
        ? { toolInvocations: am.toolInvocations }
        : {}),
      ...(assistantMessageId === undefined
        ? {}
        : { id: agentMessageId(assistantMessageId, index) }),
    })),
    ...(omitLeadReply
      ? []
      : [
          {
            role: 'assistant',
            content: stripTitleTags(assistantResponse),
            ...(toolInvocations && toolInvocations.length > 0 && { toolInvocations }),
            ...(assistantMessageId === undefined ? {} : { id: assistantMessageId }),
          },
        ]),
  ].filter((msg) => msg != null && msg.role && msg.content !== undefined);

  const title = extractConversationTitle(assistantResponse, messages);

  // Update conversation metadata
  const preview = stripTitleTags(
    omitLeadReply ? (agentMessages?.at(-1)?.content ?? '') : assistantResponse,
  ).slice(0, 100);
  const writeMetadata = (db: Executor = getDb()) =>
    upsertConversation(db, {
      oxyUserId: userId,
      conversationId,
      // A group turn saved before its members answered has no reply to preview yet: the room
      // writes the preview as each reply lands, and an empty one here would blank the last.
      ...(omitLeadReply && preview === '' ? {} : { lastMessage: preview }),
      titleOnInsert: title,
      source: channelSource ?? source ?? 'app',
      agentId,
      ...(originApp ? { originApp } : {}),
    });

  if (channelSource) {
    // A retried turn whose reply is stored adds nothing, and changes nothing: not the preview,
    // not the conversation's place in the list.
    return appendChannelTurn(userId, conversationId, channelMessage, turnTail, writeMetadata);
  }
  await writeMetadata();

  const [storedCount, lastStored] = await Promise.all([
    countMessages(getDb(), userId, conversationId),
    findLastMessage(getDb(), userId, conversationId),
  ]);

  // Fast path: stored history is exactly the client history minus the new turn,
  // with a contiguous seq that matches the client's last echoed message.
  const canAppend =
    storedCount === clientHistory.length - 1 &&
    (storedCount === 0 ||
      (lastStored?.seq === storedCount - 1 &&
        sameMessage(lastStored, clientHistory[storedCount - 1])));

  if (canAppend) {
    const toAppend = [...clientHistory.slice(storedCount), ...turnTail];
    if (toAppend.length === 0) return {};
    try {
      await insertMessages(
        getDb(),
        toAppend.map((message, i) =>
          buildStoredMessage(message, userId, conversationId, storedCount + i),
        ),
      );
      return { appendedFromSeq: storedCount };
    } catch (err) {
      // Concurrent append claimed the same seq or message → converge via full rewrite below.
      if (!isAppendConflict(err)) throw err;
    }
  }

  // Divergence / legacy / no-seq / race → full rewrite. seq is the absolute index.
  // Messages an agent wrote on its own that this client has not seen yet are
  // kept, in place: the client's copy is authoritative for what IT sent, not
  // for what arrived while it was away.
  await rewriteMessages(getDb(), userId, conversationId, (stored) => {
    const allMessages = withStoredIds(stored, [
      ...keepAgentOutreach(stored, clientHistory),
      ...turnTail,
    ]);
    return allMessages.map((message, index) =>
      buildStoredMessage(message, userId, conversationId, index),
    );
  });
  return { reload: true };
}

/**
 * One message the server appends: a voice call's (ADR 0017 §3), text; a gemie bot's third-party
 * turn's, whose user message may be a channel message's parts (its words and its kept media).
 */
export interface AppendedMessage<Content extends MessageContent = string> {
  /** The client id the message is stored under. */
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: Content;
  readonly toolInvocations?: ToolInvocation[];
  /** A spoken answer the person talked over: how much of it they heard. */
  readonly interruptedAfterMs?: number;
}

/** Retries on the one conflict a concurrent append produces. */
const MAX_APPEND_ATTEMPTS = 4;

/**
 * Append messages at the END of a conversation, without the client's history.
 *
 * `saveConversation` reconciles the CLIENT's view of a thread with what is
 * stored, which is the right writer for a turn the client sent. A voice call
 * has no such view: the server is the only one that saw the exchange, so it
 * appends — the next `seq` after the last stored message, retried on exactly
 * the conflict a concurrent append claiming the same `seq` produces (the
 * `postAgentMessage` and Alia-outreach precedent). Each exchange is appended
 * as it completes, so the thread survives a dropped call.
 *
 * The conversation row is upserted after the messages land (they have no foreign key to it), so a
 * call opened in a conversation that did not exist yet creates it, owned by the person, and a
 * retried append that stored nothing changes nothing.
 */
export async function appendConversationMessages<Content extends MessageContent = string>(params: {
  readonly userId: string;
  readonly conversationId: string;
  readonly messages: readonly AppendedMessage<Content>[];
  /** The gemie of the call, which a conversation it creates belongs to. */
  readonly agentId: string;
  readonly titleOnInsert: string;
  /** Where a conversation it creates comes from; `app` unless said. */
  readonly source?: ConversationSource;
}): Promise<void> {
  const { userId, conversationId, messages } = params;
  if (messages.length === 0) return;
  const appended = await appendAtEnd(
    userId,
    conversationId,
    messages.map((message) => message.id),
    (from, kept) =>
      messages
        .filter((message) => kept.has(message.id))
        .map((message, index) => ({
          conversationId,
          oxyUserId: userId,
          clientMessageId: message.id,
          role: message.role,
          content: message.content,
          seq: from + index,
          createdAt: new Date(),
          ...(message.toolInvocations && message.toolInvocations.length > 0
            ? { toolInvocations: message.toolInvocations }
            : {}),
          ...(message.interruptedAfterMs === undefined
            ? {}
            : { interruptedAfterMs: Math.round(message.interruptedAfterMs) }),
        })),
    async (tx, kept) => {
      const last = messages
        .filter((message) => kept.has(message.id))
        .reverse()
        .map((message) => turnContentText(message.content))
        .find((text) => text.trim() !== '');
      await upsertConversation(tx, {
        oxyUserId: userId,
        conversationId,
        ...(last ? { lastMessage: last.slice(0, 100) } : {}),
        titleOnInsert: params.titleOnInsert,
        source: params.source ?? 'app',
        agentId: params.agentId,
      });
    },
  );
  // Every message was already there (a retried delivery): nothing changed, not even the preview.
  if (appended === null) return;
  void publishConversation(userId, conversationId, { appendedFromSeq: appended.from });
}

/**
 * Insert rows at the END of a conversation: from the `seq` after its last message, retried on
 * exactly the conflicts a concurrent append produces (the same `seq`, the same message). A message
 * the thread already holds is not stored again: `rowsFrom` receives the ids still to store, so a
 * retried delivery of a channel's message is kept once. Returns the first `seq` written and the ids
 * stored, or `null` when every message was already there.
 *
 * The messages and the conversation row they belong to (`withConversation`) are written in ONE
 * transaction: a turn that stopped between the two would leave messages a retry finds stored, and
 * so never writes the conversation they are read through.
 */
async function appendAtEnd(
  userId: string,
  conversationId: string,
  ids: readonly string[],
  rowsFrom: (seq: number, kept: ReadonlySet<string>) => NewMessage[],
  withConversation: (tx: Executor, kept: ReadonlySet<string>) => Promise<unknown>,
): Promise<{ from: number; kept: ReadonlySet<string> } | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getDb().transaction(async (tx) => {
        const [stored, count, existing] = await Promise.all([
          findLastMessage(tx, userId, conversationId),
          countMessages(tx, userId, conversationId),
          existingClientMessageIds(tx, userId, conversationId, ids),
        ]);
        const kept = new Set(ids.filter((id) => !existing.has(id)));
        if (kept.size === 0) return null;
        // A legacy thread without `seq` continues after its last position.
        const next = stored?.seq == null ? count : stored.seq + 1;
        await insertMessages(tx, rowsFrom(next, kept));
        await withConversation(tx, kept);
        return { from: next, kept };
      });
    } catch (err) {
      if (attempt >= MAX_APPEND_ATTEMPTS || !isAppendConflict(err)) throw err;
    }
  }
}

/**
 * A channel turn, appended after whatever its conversation holds by then.
 *
 * A channel is not a client with a view of the thread. It keeps each message the moment it arrives
 * (`gemie-telegram-bot.ts`, `POST /channel-accounts/messages`) and its turns overlap, so the history
 * it sent is the model's context, not the stored transcript. Reconciled from it, a reply deleted
 * every message that arrived while it ran, and a history the channel could not read rewrote the
 * thread down to the new turn. Its person's message is appended too when the channel did not keep
 * it (a system bot's).
 */
async function appendChannelTurn(
  userId: string,
  conversationId: string,
  sent: InputMessage | undefined,
  turnTail: readonly InputMessage[],
  writeMetadata: (tx: Executor) => Promise<unknown>,
): Promise<ConversationChange> {
  const messages = withStoredIds([], [...(sent ? [sent] : []), ...turnTail]);
  // A retried turn whose reply is stored adds nothing, and changes nothing: not the preview, not
  // the conversation's place in the list.
  const appended = await appendAtEnd(
    userId,
    conversationId,
    messages.map((message) => message.id as string),
    (from, kept) =>
      messages
        .filter((message) => kept.has(message.id as string))
        .map((message, index) => buildStoredMessage(message, userId, conversationId, from + index)),
    writeMetadata,
  );
  return appended === null ? {} : { appendedFromSeq: appended.from };
}

/**
 * Every message with its id: its own, or else the id of the stored message it is (same role and
 * content, in order), or else a new one. The id is the message's identity for good, what a vote,
 * a reaction and a read-aloud clip find it by: it was `msg-<seq>`, its position, so a rewrite
 * that moved it renamed it and the same name later meant another message.
 */
function withStoredIds(
  stored: readonly MessageRow[],
  list: readonly InputMessage[],
): InputMessage[] {
  const named = new Set(list.flatMap((message) => (message.id === undefined ? [] : [message.id])));
  let cursor = 0;
  return list.map((message) => {
    if (message.id !== undefined) return message;
    for (const [index, row] of stored.entries()) {
      if (index < cursor) continue;
      const id = row.clientMessageId;
      if (id === null || named.has(id) || !sameMessage(row, message)) continue;
      cursor = index + 1;
      named.add(id);
      return { ...message, id };
    }
    return { ...message, id: uuidv7(), minted: true };
  });
}

/**
 * The client's history with every agent-written message it does not have put
 * back where it was stored: right after the last stored message before it that
 * the client DOES have (or first, if none).
 *
 * "Has" is by id when the client echoed the agent's id, else by role and
 * content — the same equality the append fast path uses.
 */
export function keepAgentOutreach(
  stored: readonly MessageRow[],
  client: readonly InputMessage[],
): InputMessage[] {
  const present = (row: MessageRow) =>
    client.some(
      (message) =>
        (message.id !== undefined && message.id === row.clientMessageId) ||
        sameMessage(row, message),
    );
  const insertAfter = new Map<number, InputMessage[]>();
  for (const [index, row] of stored.entries()) {
    if (!isAgentWrittenMessageId(row.clientMessageId) || present(row)) continue;
    let anchor = -1;
    for (let back = index - 1; back >= 0 && anchor === -1; back--) {
      const previous = stored[back]!;
      if (isAgentWrittenMessageId(previous.clientMessageId)) continue;
      for (let j = client.length - 1; j >= 0; j--) {
        if (sameMessage(previous, client[j]!)) {
          anchor = j;
          break;
        }
      }
    }
    const message = toStoredMessage(row);
    const kept: InputMessage = {
      role: message.role,
      content: message.content,
      ...(row.clientMessageId ? { id: row.clientMessageId } : {}),
      ...(message.agentInfo ? { agentInfo: message.agentInfo } : {}),
    };
    insertAfter.set(anchor, [...(insertAfter.get(anchor) ?? []), kept]);
  }
  if (insertAfter.size === 0) return [...client];
  const merged: InputMessage[] = [...(insertAfter.get(-1) ?? [])];
  for (const [j, message] of client.entries()) {
    merged.push(message, ...(insertAfter.get(j) ?? []));
  }
  return merged;
}

/**
 * What the title call may SPEND, which is not how long a title is.
 *
 * Six words need about fifteen tokens, and this was `30` on that reasoning.
 * MEASURED against production on 2026-08-25 (UTC), on the model the cheap
 * title route resolved to then: at a budget of 30 the answer came back
 * `finishReason: 'length'` having spent 28 of its 30 tokens on REASONING and
 * two on text, so `result.text` was the empty string. Every conversation went
 * untitled, with no error, no failed request and nothing in the logs. The same
 * prompt at 128, 256 and 512 answered `Viaje a Japón en primavera` and its
 * variants, after 104, 78 and 127 reasoning tokens respectively.
 *
 * A model that thinks before it speaks is the ordinary case now rather than
 * the exception, so the budget has to cover a preamble the prompt never asked
 * for and cannot see. 512 is four times the largest preamble measured; the
 * call is not billed to anyone's credits and runs once per conversation.
 */
const TITLE_OUTPUT_TOKEN_BUDGET = 512;

/**
 * Generate a conversation title using a cheap model.
 * Returns the title string (or null on failure). Does NOT write to DB.
 * Can be called in parallel with the main LLM response since it only needs the user message.
 *
 * ## Every way this returns `null` says so, in operator logs
 *
 * A title that never arrives is invisible from the outside: the turn streams,
 * the conversation saves, and the only symptom is a name nobody chose. So each
 * of the three exits names its own reason — no model, a call that threw, and a
 * call that succeeded and produced nothing usable. The last one is the one that
 * had no log at all, and it is the one that was firing.
 *
 * The reason belongs HERE and not at the caller, which holds only `string |
 * null` and cannot tell those apart. It goes to the log and never to the
 * response body: the provider and the deployment id are operator facts, which
 * `AGENTS.md` places on the truthful side of the line, and the client is told
 * nothing at all — it simply receives no `alia.title` event.
 *
 * `resolveUtilityModel` is INSIDE the try. It throws when the catalogue is
 * unreachable or offers no fit model, and the throw would otherwise leave this
 * function entirely and land in the caller's catch, which is the one place that
 * cannot say what happened.
 */
export async function generateTitle(userMessage: string): Promise<string | null> {
  try {
    const resolved = await resolveUtilityModel();

    const model = getAIModel(resolved, 'background');
    const result = await generateText({
      model,
      system:
        'Generate a concise conversation title (max 6 words) in the same language as the user message. Return ONLY the title, no quotes or trailing punctuation.',
      messages: [{ role: 'user', content: userMessage }],
      maxOutputTokens: TITLE_OUTPUT_TOKEN_BUDGET,
    });

    const title = result.text
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/\.+$/, '');
    if (title.length === 0 || title.length >= 100) {
      log.chat.warn(
        {
          provider: resolved.provider,
          modelId: resolved.modelId,
          finishReason: result.finishReason,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: result.usage.reasoningTokens,
          titleLength: title.length,
        },
        'Title generation produced no usable title',
      );
      return null;
    }
    return title;
  } catch (err) {
    log.chat.error({ err }, 'Title generation failed');
    return null;
  }
}

/**
 * Generate a conversation title asynchronously and save it to DB.
 * Skips if the conversation already has a meaningful title or was manually titled.
 * Used as fire-and-forget fallback for non-streaming paths.
 */
export async function generateConversationTitle(
  userId: string,
  conversationId: string,
  userMessage: string,
): Promise<void> {
  try {
    const conv = await findConversation(getDb(), userId, conversationId);
    if (!conv || conv.isManualTitle) return;
    const messageCount = await countMessagesInConversation(getDb(), conversationId);
    if (messageCount > 3) return;

    const title = await generateTitle(userMessage);
    if (title) {
      await updateConversationTitle(getDb(), userId, conversationId, title);
      void publishConversation(userId, conversationId);
      // The title is a model summary of the user's own conversation.
      log.chat.info({ conversationId }, 'Auto-generated conversation title');
    }
  } catch (err) {
    log.chat.error({ err, conversationId }, 'generateConversationTitle failed');
  }
}

/**
 * One message, ready for `messages`.
 *
 * `role` and `content` are narrowed here rather than validated: every caller of
 * `saveConversation` is server-side (`lib/chat/provider-loop.ts` and the
 * non-streaming branch beside it), and `clientHistory` is the SAME array the
 * request was answered from — so a role outside the tuple would already have
 * been refused by the model call. The cast records that, and the column's CHECK
 * is what catches it if a future caller is not.
 */
function buildStoredMessage(
  message: InputMessage,
  userId: string,
  conversationId: string,
  seq: number,
): NewMessage {
  return {
    conversationId,
    oxyUserId: userId,
    role: message.role as MessageRole,
    content: message.content ?? '',
    seq,
    createdAt: new Date(),
    ...(message.toolInvocations ? { toolInvocations: message.toolInvocations } : {}),
    ...(message.agentInfo ? { agentInfo: message.agentInfo } : {}),
    clientMessageId: message.id ?? uuidv7(),
    // A message's feedback follows its id when the id is its own: the client's, or the stored
    // message it was matched to. A new id names a new message.
    retainFeedback: message.id !== undefined && message.minted !== true,
  };
}
