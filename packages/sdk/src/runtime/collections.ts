/**
 * How a person files their conversations — folders, projects, pins, favourites — on their account,
 * so every device shows the same (Gemies `docs/realtime.mdx`, "Collections").
 *
 * One query holds the whole snapshot (`GET /v1/conversations/collections`). Every change is drawn
 * at once (optimistic), sent, and replaced by the snapshot the server answers; the other devices
 * receive the same snapshot as the realtime `collections` event. Nothing is stored on the device.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useMemo } from 'react';
import type { CollectionsSnapshotWire } from '../realtime/contract';
import {
  type CollectionFields,
  type ConversationCollection,
  type ConversationCollectionKind,
  type ConversationCollections,
  EMPTY_COLLECTIONS,
  type LocalCollections,
  readCollectionsSnapshot,
} from './collections-model';

export type {
  CollectionFields,
  ConversationCollection,
  ConversationCollectionKind,
  ConversationCollections,
  LocalCollections,
} from './collections-model';
export { readCollectionsSnapshot } from './collections-model';
import { type GemieApi, useGemieApi } from './api';
import { gemieQueryKeys } from './query-keys';
import { API_ROUTES } from './routes';

/** The person's folders, projects, pins and favourites. Kept current by the realtime connection. */
export function useConversationCollections(): ConversationCollections {
  const api = useGemieApi();
  const { canUsePrivateApi, isAccountCacheReady } = useOxy();
  const query = useQuery({
    queryKey: gemieQueryKeys.collections,
    queryFn: async () =>
      readCollectionsSnapshot(
        (await api.get<CollectionsSnapshotWire>(API_ROUTES.collections.list)).data,
      ),
    enabled: canUsePrivateApi && isAccountCacheReady,
    // No timer and no refocus: the `collections` event keeps it, and a reset reads it again.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  return query.data ?? EMPTY_COLLECTIONS;
}

/**
 * Bring what this device filed before collections were the account's into the account (the
 * server merges by name, so every device may bring its own). Resolves with the account's snapshot.
 */
export async function importCollections(
  api: GemieApi,
  local: LocalCollections,
): Promise<ConversationCollections> {
  const { data } = await api.post<CollectionsSnapshotWire>(API_ROUTES.collections.import, local);
  return readCollectionsSnapshot(data);
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
 * by what the server answers; a refused change puts the server's state back.
 */
export function useCollectionActions(): CollectionActions {
  const api = useGemieApi();
  const queryClient = useQueryClient();

  const run = useCallback(
    async (
      draw: (current: ConversationCollections) => ConversationCollections,
      send: () => Promise<{ data: CollectionsSnapshotWire }>,
    ) => {
      await queryClient.cancelQueries({ queryKey: gemieQueryKeys.collections });
      queryClient.setQueryData<ConversationCollections>(gemieQueryKeys.collections, (current) =>
        draw(current ?? EMPTY_COLLECTIONS),
      );
      try {
        const { data } = await send();
        queryClient.setQueryData(gemieQueryKeys.collections, readCollectionsSnapshot(data));
      } catch (error) {
        void queryClient.invalidateQueries({ queryKey: gemieQueryKeys.collections });
        throw error;
      }
    },
    [queryClient],
  );

  return useMemo<CollectionActions>(() => {
    const R = API_ROUTES.collections;
    const edit =
      (id: string, change: (c: ConversationCollection) => ConversationCollection) =>
      (current: ConversationCollections) => ({
        ...current,
        collections: current.collections.map((c) => (c.id === id ? change(c) : c)),
      });
    const toggle = (list: string[], id: string, on: boolean) =>
      on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);
    return {
      createCollection: (kind, fields) =>
        run(
          (current) => ({
            ...current,
            collections: [
              ...current.collections,
              {
                id: `pending-${Date.now()}`,
                kind,
                name: fields.name,
                description: fields.description ?? null,
                icon: fields.icon ?? null,
                color: fields.color ?? null,
                isFavorite: false,
                isExpanded: true,
                conversationIds: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
          () => api.post(R.create, { kind, ...fields }),
        ),
      updateCollection: (id, fields) =>
        run(
          edit(id, (c) => ({ ...c, ...fields, name: fields.name ?? c.name })),
          () => api.patch(R.one(id), fields),
        ),
      deleteCollection: (id) =>
        run(
          (current) => ({
            ...current,
            collections: current.collections.filter((c) => c.id !== id),
          }),
          () => api.delete(R.one(id)),
        ),
      addToCollection: (id, conversationId) =>
        run(
          edit(id, (c) => ({
            ...c,
            conversationIds: toggle(c.conversationIds, conversationId, true),
          })),
          () => api.put(R.member(id, conversationId)),
        ),
      removeFromCollection: (id, conversationId) =>
        run(
          edit(id, (c) => ({
            ...c,
            conversationIds: toggle(c.conversationIds, conversationId, false),
          })),
          () => api.delete(R.member(id, conversationId)),
        ),
      setPinned: (conversationId, pinned) =>
        run(
          (current) => ({ ...current, pinned: toggle(current.pinned, conversationId, pinned) }),
          () => api.patch(API_ROUTES.conversations.marks(conversationId), { pinned }),
        ),
      setFavorite: (conversationId, favorite) =>
        run(
          (current) => ({
            ...current,
            favorites: toggle(current.favorites, conversationId, favorite),
          }),
          () => api.patch(API_ROUTES.conversations.marks(conversationId), { favorite }),
        ),
    };
  }, [api, run]);
}
