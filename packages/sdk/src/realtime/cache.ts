/**
 * Realtime events into the conversation runtime's React Query cache (`docs/realtime.mdx`).
 *
 * Every write here is an idempotent upsert of what the server says now — the sidebar row by
 * conversation id, a message by its id, a reaction by its revision — so applying an event twice,
 * or again over a snapshot that predates it (`noteSnapshot`), converges on the same state. Nothing
 * here refetches on a timer: only `reload` (a rewritten thread) and `reset` (a client too far
 * behind) read again, and only what they name.
 */

import type { QueryClient } from '@tanstack/react-query';
import { normalizeConversationMessages } from '../runtime/message-history';
import { gemieQueryKeys, type ConversationsFilter } from '../runtime/query-keys';
import { updateReactionCaches } from '../runtime/reaction-cache';
import type { Conversation, ConversationsInfiniteData, Message } from '../runtime/types';
import type { RealtimeConnection } from './connection';
import type { RealtimeConversationRow, RealtimeData, RealtimeFrame } from './contract';
import { readCollectionsSnapshot } from '../runtime/collections-model';

function toConversation(row: RealtimeConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    ...(row.lastMessage === null ? {} : { lastMessage: row.lastMessage }),
    source: row.source,
    agentId: row.agentId,
    memberAgentIds: row.memberAgentIds,
    spaceId: row.spaceId,
    ...(row.kind === undefined ? {} : { kind: row.kind }),
    ...(row.members === undefined ? {} : { members: row.members }),
    threadId: row.threadId,
    app: row.app,
    unreadCount: row.unreadCount,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    messages: [],
  };
}

function matches(filter: ConversationsFilter | undefined, row: Conversation): boolean {
  // The person's own lists never hold a conversation between their gemies, and that list holds
  // nothing else (ADR 0041).
  if ((filter?.kind ?? 'person') !== (row.kind ?? 'person')) return false;
  if (!filter) return true;
  if (filter.agentId !== undefined && row.agentId !== filter.agentId) return false;
  if (filter.app !== undefined && row.app !== filter.app) return false;
  return true;
}

/**
 * The row where the list's order puts it: newest `updatedAt` first, on the first page. A row whose
 * copy is already newer than this one keeps that copy (an event replayed over a fresher snapshot).
 */
export function placeConversation(
  data: ConversationsInfiniteData | undefined,
  row: Conversation,
): ConversationsInfiniteData | undefined {
  if (!data?.pages?.length) return data;
  let existing: Conversation | undefined;
  const pages = data.pages.map((page) => {
    const index = page.conversations.findIndex((c) => c.id === row.id);
    if (index < 0) return page;
    existing = page.conversations[index];
    return { ...page, conversations: page.conversations.filter((c) => c.id !== row.id) };
  });
  if (existing && new Date(existing.updatedAt).getTime() > row.updatedAt.getTime()) return data;
  const [first, ...rest] = pages;
  if (!first) return data;
  const conversations = [...first.conversations];
  const at = conversations.findIndex(
    (c) => new Date(c.updatedAt).getTime() <= row.updatedAt.getTime(),
  );
  // Older than everything on the first page and not there already: it belongs to a later page,
  // which a scroll will read.
  if (at < 0 && !existing && first.hasMore) return { ...data, pages };
  conversations.splice(at < 0 ? conversations.length : at, 0, row);
  return { ...data, pages: [{ ...first, conversations }, ...rest] };
}

/**
 * The person just sent in a conversation: its row goes to the top with their words, now. The
 * server's `conversation` event replaces this with what it stored.
 */
export function bumpConversation(client: QueryClient, id: string, preview: string): void {
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: gemieQueryKeys.conversations.all })) {
    const current = query.state.data as ConversationsInfiniteData | undefined;
    const existing = current?.pages?.flatMap((page) => page.conversations).find((c) => c.id === id);
    if (!existing) continue;
    const next = placeConversation(current, {
      ...existing,
      ...(preview ? { lastMessage: preview.slice(0, 100) } : {}),
      updatedAt: new Date(),
    });
    if (next !== current) client.setQueryData(query.queryKey, next);
  }
}

function removeConversation(
  data: ConversationsInfiniteData | undefined,
  id: string,
): ConversationsInfiniteData | undefined {
  if (!data?.pages) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      conversations: page.conversations.filter((c) => c.id !== id),
    })),
  };
}

/** Messages merged by id: a copy the client drew under the same id is replaced, never doubled. */
export function mergeMessages(
  previous: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  if (incoming.length === 0) return [...previous];
  const next = [...previous];
  for (const message of incoming) {
    if (!message?.id) continue;
    const index = next.findIndex((m) => m.id === message.id);
    if (index >= 0) next[index] = { ...next[index], ...message };
    else next.push(message);
  }
  return next;
}

function applyConversation(client: QueryClient, data: RealtimeData['conversation']): void {
  const row = toConversation(data.conversation);
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: gemieQueryKeys.conversations.all })) {
    const filter = query.queryKey[1] as ConversationsFilter | undefined;
    const current = query.state.data as ConversationsInfiniteData | undefined;
    const next = matches(filter, row)
      ? placeConversation(current, row)
      : removeConversation(current, row.id);
    if (next !== current) client.setQueryData(query.queryKey, next);
  }
  const appended = data.appended ? normalizeConversationMessages(data.appended) : [];
  client.setQueryData<Conversation>(gemieQueryKeys.conversations.detail(row.id), (previous) =>
    previous
      ? {
          ...previous,
          ...row,
          messages: mergeMessages(previous.messages ?? [], appended),
        }
      : previous,
  );
  // A gemie's thread view reads which stretch is active; a message may have started a new one.
  if (appended.length > 0) void client.invalidateQueries({ queryKey: ['agent-thread'] });
  if (data.reload) {
    void client.invalidateQueries({
      queryKey: gemieQueryKeys.conversations.detail(row.id),
      exact: true,
    });
  }
}

function applyDeleted(client: QueryClient, data: RealtimeData['conversation.deleted']): void {
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: gemieQueryKeys.conversations.all })) {
    const current = query.state.data as ConversationsInfiniteData | undefined;
    const next = removeConversation(current, data.conversationId);
    if (next !== current) client.setQueryData(query.queryKey, next);
  }
  client.removeQueries({
    queryKey: gemieQueryKeys.conversations.detail(data.conversationId),
    exact: true,
  });
}

/** Apply one frame to the runtime's own caches. Pure cache writes: safe to call twice. */
export function applyRealtimeToCache(client: QueryClient, frame: RealtimeFrame): void {
  switch (frame.type) {
    case 'conversation':
      applyConversation(client, frame.data as RealtimeData['conversation']);
      return;
    case 'conversation.deleted':
      applyDeleted(client, frame.data as RealtimeData['conversation.deleted']);
      return;
    case 'message.reaction':
      {
        const update = frame.data as RealtimeData['message.reaction'];
        updateReactionCaches(client, { ...update, reactions: [...update.reactions] });
      }
      return;
    case 'collections':
      client.setQueryData(
        gemieQueryKeys.collections,
        readCollectionsSnapshot(frame.data as RealtimeData['collections']),
      );
      return;
    case 'connections':
      // The person's connected accounts and connectors: their lists are read again, once.
      void client.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all });
      void client.invalidateQueries({ queryKey: ['gemie-connectors', 'connected'] });
      return;
    default:
  }
}

/** What a client too far behind reads again: the runtime's lists and the open conversations. */
export function resetRealtimeCache(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: gemieQueryKeys.conversations.all });
  void client.invalidateQueries({ queryKey: ['conversation'] });
  void client.invalidateQueries({ queryKey: gemieQueryKeys.collections });
  void client.invalidateQueries({ queryKey: gemieQueryKeys.accounts.all });
  void client.invalidateQueries({ queryKey: ['gemie-connectors', 'connected'] });
}

const attached = new WeakMap<
  QueryClient,
  Map<RealtimeConnection, { refs: number; detach: () => void }>
>();

/**
 * Keep one QueryClient's runtime caches in step with a connection. Nested runtime providers attach
 * the same pair more than once; it is wired once and released with its last holder.
 */
export function attachRealtimeCache(
  connection: RealtimeConnection,
  client: QueryClient,
): () => void {
  let byConnection = attached.get(client);
  if (!byConnection) {
    byConnection = new Map();
    attached.set(client, byConnection);
  }
  const existing = byConnection.get(connection);
  if (existing) {
    existing.refs++;
  } else {
    const offFrames = connection.on('*', (frame) => applyRealtimeToCache(client, frame));
    const offReset = connection.onReset(() => resetRealtimeCache(client));
    byConnection.set(connection, {
      refs: 1,
      detach: () => {
        offFrames();
        offReset();
      },
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = byConnection?.get(connection);
    if (!entry) return;
    if (--entry.refs > 0) return;
    entry.detach();
    byConnection?.delete(connection);
  };
}
