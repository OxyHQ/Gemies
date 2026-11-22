/**
 * Realtime events into the signed-in account's store (`docs/realtime.mdx`).
 *
 * Every write here is an idempotent upsert of what the server says now (the conversation by id,
 * a message by its id, a reaction by its revision), so applying an event twice, or again over a
 * read that predates it (`noteSnapshot`), converges on the same state. Nothing here reads from the
 * server: what must be read again (a rewritten thread, the lists after a reset, the connections)
 * is read by the hooks that show it, which hear the same events (`useRealtimeEvent`,
 * `useRealtimeReset`).
 */
import { currentStore, type Store, withStore } from '@oxy.so/bloom-data';
import { readCollectionsSnapshot } from '../runtime/collections-model';
import { storeCollections } from '../runtime/data/collections';
import { Conversations, mergeMessages, placeConversation } from '../runtime/data/conversations';
import { storeReaction } from '../runtime/data/reactions';
import { normalizeConversationMessages } from '../runtime/message-history';
import type { Conversation } from '../runtime/types';
import type { RealtimeConnection } from './connection';
import type { RealtimeConversationRow, RealtimeData, RealtimeFrame } from './contract';

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Applies one frame to the store in scope. Pure store writes: safe to apply twice. */
export function applyRealtimeFrame(frame: RealtimeFrame): void {
  switch (frame.type) {
    case 'conversation': {
      const data = frame.data as RealtimeData['conversation'];
      const appended = data.appended ? normalizeConversationMessages(data.appended) : [];
      currentStore().batch(() => {
        placeConversation(toConversation(data.conversation));
        if (appended.length === 0) return;
        Conversations.patch(data.conversation.id, (held) =>
          held.messages ? { messages: mergeMessages(held.messages, appended) } : undefined,
        );
      });
      return;
    }
    case 'conversation.deleted':
      Conversations.remove((frame.data as RealtimeData['conversation.deleted']).conversationId);
      return;
    case 'message.reaction': {
      const update = frame.data as RealtimeData['message.reaction'];
      storeReaction({ ...update, reactions: [...update.reactions] });
      return;
    }
    case 'collections':
      storeCollections(readCollectionsSnapshot(frame.data as RealtimeData['collections']));
      return;
    default:
  }
}

const attached = new WeakMap<
  Store,
  Map<RealtimeConnection, { refs: number; detach: () => void }>
>();

/**
 * Keeps a store in step with a connection. Providers on the same connection and store attach the
 * pair more than once; it is wired once and released with its last holder. Frames that arrive
 * after the store's account was left go to its closed store, which drops them.
 */
export function attachRealtimeStore(connection: RealtimeConnection, store: Store): () => void {
  let byConnection = attached.get(store);
  if (!byConnection) {
    byConnection = new Map();
    attached.set(store, byConnection);
  }
  const existing = byConnection.get(connection);
  if (existing) existing.refs++;
  else {
    const detach = connection.on('*', (frame) => withStore(store, () => applyRealtimeFrame(frame)));
    byConnection.set(connection, { refs: 1, detach });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = byConnection?.get(connection);
    if (!entry || --entry.refs > 0) return;
    entry.detach();
    byConnection?.delete(connection);
  };
}
