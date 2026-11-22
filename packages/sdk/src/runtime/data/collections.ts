/**
 * How the person files their conversations (folders, projects, pins, favourites), held whole as
 * one answer in the signed-in account's store (Gemies `docs/realtime.mdx`, "Collections").
 *
 * Every change is drawn at once (its optimistic layer), sent, and replaced by the snapshot the
 * server answers; a refusal drops the layer, which puts the server's state back. The other devices
 * receive the same snapshot as the realtime `collections` event.
 */
import { action } from '@oxy.so/bloom-data';
import type { CollectionsSnapshotWire } from '../../realtime/contract';
import type { GemieApi } from '../api';
import {
  type CollectionFields,
  type ConversationCollection,
  type ConversationCollectionKind,
  type ConversationCollections,
  type LocalCollections,
  readCollectionsSnapshot,
} from '../collections-model';
import { API_ROUTES } from '../routes';
import { rereadOn } from '../../realtime/reread';
import { answerSource } from './answer';
import { ACCOUNT, gemieRead } from './read';

/**
 * The person's collections: read once per account, then kept by the `collections` event (no timer,
 * no refocus); a realtime reset reads them again.
 */
export const conversationCollections = answerSource('gemies.collections', {
  ...gemieRead,
  persist: true,
  key: (_api: GemieApi) => ACCOUNT,
  stale: Number.POSITIVE_INFINITY,
  load: async ({ signal }, api) =>
    readCollectionsSnapshot(
      (await api.get<CollectionsSnapshotWire>(API_ROUTES.collections.list, { signal })).data,
    ),
});

rereadOn('reset', conversationCollections);

/** The snapshot as the server (or another device) answered it. */
export function storeCollections(snapshot: ConversationCollections): void {
  conversationCollections.entity.put({ id: ACCOUNT, value: snapshot });
}

/** Draws a change over the held snapshot, as the calling action's layer. */
function draw(change: (current: ConversationCollections) => ConversationCollections): void {
  conversationCollections.entity.update(ACCOUNT, (held) => ({
    id: ACCOUNT,
    value: change(held.value),
  }));
}

const settle = ({ data }: { data: CollectionsSnapshotWire }) =>
  storeCollections(readCollectionsSnapshot(data));

const edit =
  (id: string, change: (c: ConversationCollection) => ConversationCollection) =>
  (current: ConversationCollections): ConversationCollections => ({
    ...current,
    collections: current.collections.map((c) => (c.id === id ? change(c) : c)),
  });

/** `ids` with `id` in it (`on`) or out of it, unchanged when it already is. */
const toggle = (ids: readonly string[], id: string, on: boolean): string[] =>
  on ? (ids.includes(id) ? [...ids] : [...ids, id]) : ids.filter((x) => x !== id);

const R = API_ROUTES.collections;

export const createCollection = action({
  optimistic: (
    _api: GemieApi,
    kind: ConversationCollectionKind,
    fields: CollectionFields & { name: string },
  ) =>
    draw((current) => {
      const now = new Date().toISOString();
      return {
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
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    }),
  run: (api, kind, fields) => api.post<CollectionsSnapshotWire>(R.create, { kind, ...fields }),
  settle,
});

export const updateCollection = action({
  optimistic: (_api: GemieApi, id: string, fields: CollectionFields) =>
    draw(edit(id, (c) => ({ ...c, ...fields, name: fields.name ?? c.name }))),
  run: (api, id, fields) => api.patch<CollectionsSnapshotWire>(R.one(id), fields),
  settle,
});

export const deleteCollection = action({
  optimistic: (_api: GemieApi, id: string) =>
    draw((current) => ({
      ...current,
      collections: current.collections.filter((c) => c.id !== id),
    })),
  run: (api, id) => api.delete<CollectionsSnapshotWire>(R.one(id)),
  settle,
});

/** Files a conversation in a collection (`member: true`) or takes it out. */
export const setCollectionMember = action({
  optimistic: (_api: GemieApi, id: string, conversationId: string, member: boolean) =>
    draw(
      edit(id, (c) => ({
        ...c,
        conversationIds: toggle(c.conversationIds, conversationId, member),
      })),
    ),
  run: (api, id, conversationId, member) =>
    member
      ? api.put<CollectionsSnapshotWire>(R.member(id, conversationId))
      : api.delete<CollectionsSnapshotWire>(R.member(id, conversationId)),
  settle,
});

export const setConversationPinned = action({
  optimistic: (_api: GemieApi, conversationId: string, pinned: boolean) =>
    draw((current) => ({ ...current, pinned: toggle(current.pinned, conversationId, pinned) })),
  run: (api, conversationId, pinned) =>
    api.patch<CollectionsSnapshotWire>(API_ROUTES.conversations.marks(conversationId), { pinned }),
  settle,
});

export const setConversationFavorite = action({
  optimistic: (_api: GemieApi, conversationId: string, favorite: boolean) =>
    draw((current) => ({
      ...current,
      favorites: toggle(current.favorites, conversationId, favorite),
    })),
  run: (api, conversationId, favorite) =>
    api.patch<CollectionsSnapshotWire>(API_ROUTES.conversations.marks(conversationId), {
      favorite,
    }),
  settle,
});

/**
 * Brings what this device filed before collections were the account's into the account (the
 * server merges by name, so every device may bring its own); the account's snapshot it answers is
 * stored and returned.
 */
export const importCollections = action({
  run: async (api: GemieApi, local: LocalCollections) => {
    const { data } = await api.post<CollectionsSnapshotWire>(R.import, local);
    return readCollectionsSnapshot(data);
  },
  settle: storeCollections,
});
