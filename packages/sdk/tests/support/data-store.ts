import { Store, withStore } from '@oxy.so/bloom-data';
import { ConversationList, Conversations } from '../../src/runtime/data/conversations';
import type { Conversation } from '../../src/runtime/types';

/** An account's store for one test, memory only. */
export const freshStore = () => new Store();

/** Holds `rows` as a list the server answered (`key`, default the person's own list). */
export function seedList(
  store: Store,
  rows: readonly Conversation[],
  { key = 'all', hasMore = false }: { key?: string; hasMore?: boolean } = {},
): void {
  withStore(store, () => {
    Conversations.put([...rows]);
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
  withStore(store, () => Conversations.get(id));
