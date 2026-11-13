/**
 * The data of a person's collections, without React (`runtime/collections.ts` has the hooks), so the
 * realtime cache can read a `collections` frame without loading the UI client.
 */

import type { CollectionsSnapshotWire } from '../realtime/contract';

export type ConversationCollectionKind = 'folder' | 'project';

export interface ConversationCollection {
  id: string;
  kind: ConversationCollectionKind;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  isFavorite: boolean;
  isExpanded: boolean;
  conversationIds: string[];
  /** ISO 8601: the snapshot is persisted as JSON by hosts that keep their cache. */
  createdAt: string;
  updatedAt: string;
}

export interface ConversationCollections {
  collections: ConversationCollection[];
  /** Pinned conversations, oldest pin first. */
  pinned: string[];
  favorites: string[];
}

/** What a collection may be created or edited with. */
export interface CollectionFields {
  name?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  isFavorite?: boolean;
  isExpanded?: boolean;
}

/** What a device filed before collections were the account's (`importCollections`). */
export interface LocalCollections {
  pinned: string[];
  favorites: string[];
  folders: Array<CollectionFields & { name: string; conversationIds: string[] }>;
  projects: Array<CollectionFields & { name: string; conversationIds: string[] }>;
}

export const EMPTY_COLLECTIONS: ConversationCollections = {
  collections: [],
  pinned: [],
  favorites: [],
};

/** The wire snapshot as the runtime keeps it (a copy: the cache never shares a frame's arrays). */
export function readCollectionsSnapshot(wire: CollectionsSnapshotWire): ConversationCollections {
  return {
    collections: wire.collections.map((c) => ({
      ...c,
      conversationIds: [...c.conversationIds],
    })),
    pinned: [...wire.pinned],
    favorites: [...wire.favorites],
  };
}
