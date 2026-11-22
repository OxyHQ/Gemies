/**
 * How a person files their conversations (folders, projects, pins, favourites) on their account,
 * so every device shows the same (Gemies `docs/realtime.mdx`, "Collections"). The snapshot is held
 * in the account's store (`data/collections.ts`) and kept current by the realtime connection.
 */

import { skip, useStore, withStore } from '@oxy.so/bloom-data';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMemo } from 'react';
import { useRealtimeReset } from '../realtime/react';
import { type GemieApi, useGemieApi } from './api';
import {
  type CollectionFields,
  type ConversationCollectionKind,
  type ConversationCollections,
  EMPTY_COLLECTIONS,
} from './collections-model';
import {
  conversationCollections,
  createCollection,
  deleteCollection,
  setCollectionMember,
  setConversationFavorite,
  setConversationPinned,
  updateCollection,
} from './data/collections';
import { useAnswer } from './data/answer';

export type {
  CollectionFields,
  ConversationCollection,
  ConversationCollectionKind,
  ConversationCollections,
  LocalCollections,
} from './collections-model';
export { readCollectionsSnapshot } from './collections-model';

/** The person's folders, projects, pins and favourites. Kept current by the realtime connection. */
export function useConversationCollections(): ConversationCollections {
  const api = useGemieApi();
  const { canUsePrivateApi } = useOxy();
  const view = useAnswer(conversationCollections, ...(canUsePrivateApi ? [api] : [skip]));
  useRealtimeReset(() => void view.refresh());
  return view.value ?? EMPTY_COLLECTIONS;
}

export interface CollectionActions {
  createCollection(
    kind: ConversationCollectionKind,
    fields: CollectionFields & { name: string },
  ): Promise<void>;
  updateCollection(id: string, fields: CollectionFields): Promise<void>;
  deleteCollection(id: string): Promise<void>;
  addToCollection(id: string, conversationId: string): Promise<void>;
  removeFromCollection(id: string, conversationId: string): Promise<void>;
  setPinned(conversationId: string, pinned: boolean): Promise<void>;
  setFavorite(conversationId: string, favorite: boolean): Promise<void>;
}

/**
 * Change how the person files their conversations. Each change is drawn at once and then replaced
 * by what the server answers; a refused change puts the server's state back, and rejects.
 */
export function useCollectionActions(): CollectionActions {
  const api = useGemieApi();
  const store = useStore();
  return useMemo<CollectionActions>(() => {
    const call = <A extends unknown[]>(
      action: (api: GemieApi, ...args: A) => Promise<unknown>,
      ...args: A
    ) => withStore(store, () => action(api, ...args)).then(() => undefined);
    return {
      createCollection: (kind, fields) => call(createCollection, kind, fields),
      updateCollection: (id, fields) => call(updateCollection, id, fields),
      deleteCollection: (id) => call(deleteCollection, id),
      addToCollection: (id, conversationId) => call(setCollectionMember, id, conversationId, true),
      removeFromCollection: (id, conversationId) =>
        call(setCollectionMember, id, conversationId, false),
      setPinned: (conversationId, pinned) => call(setConversationPinned, conversationId, pinned),
      setFavorite: (conversationId, favorite) =>
        call(setConversationFavorite, conversationId, favorite),
    };
  }, [api, store]);
}
