import { Store, withStore } from '@oxy.so/bloom-data';
import {
  ConversationList,
  ConversationMessages,
  Conversations,
  heldConversation as held,
  messagesRecord,
} from '../../src/runtime/data/conversations';
import type { Conversation } from '../../src/runtime/types';

/** An account's store for one test, memory only. */
export const freshStore = () => new Store();

/** Holds a conversation as the store keeps it: its row, and its messages when it has some. */
export function holdConversation(store: Store, conversation: Conversation): void {
  withStore(store, () =>
    conversation.messages === undefined
      ? Conversations.put(conversation)
      : ConversationMessages.put(messagesRecord(conversation)),
  );
}

/** Holds `rows` as a list the server answered (`key`, default the person's own list). */
export function seedList(
  store: Store,
  rows: readonly Conversation[],
  { key = 'all', hasMore = false }: { key?: string; hasMore?: boolean } = {},
): void {
  for (const row of rows) holdConversation(store, row);
  withStore(store, () => {
    ConversationList.set(key, () => ({
      ids: rows.map((row) => row.id),
      extra: undefined,
      next: hasMore ? 'next' : undefined,
      hasMore,
      visited: [],
      updatedAt: Date.now(),
      origin: 'network',
    }));
  });
}

/** The ids a held list shows, in order. */
export const listIds = (store: Store, key = 'all'): readonly string[] =>
  withStore(store, () => ConversationList.get(key)?.ids ?? []);

/** A held conversation, as readers see it. */
export const heldConversation = (store: Store, id: string): Conversation | undefined =>
  withStore(store, () => held(id));
