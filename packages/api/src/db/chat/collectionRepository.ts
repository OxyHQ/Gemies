/**
 * Folders, projects, pins and favourites: how a person files their conversations, on their account
 * (`db/schema/collections.ts`). Every read and write is scoped by the owner in the WHERE, so
 * another account's collection is indistinguishable from a missing one.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  COLLECTION_LIMITS,
  type ConversationCollectionKind,
} from '../../domain/conversation-collections.js';
import type { ApiDatabase, Executor } from '../index';
import { conversations } from '../schema/chat';
import { conversationCollectionItems, conversationCollections } from '../schema/collections';

export interface CollectionRecord {
  readonly id: string;
  readonly kind: ConversationCollectionKind;
  readonly name: string;
  readonly description: string | null;
  readonly icon: string | null;
  readonly color: string | null;
  readonly isFavorite: boolean;
  readonly isExpanded: boolean;
  readonly conversationIds: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything a person's sidebar files by: the realtime `collections` event carries exactly this. */
export interface CollectionsSnapshot {
  readonly collections: CollectionRecord[];
  /** Pinned conversations, oldest pin first. */
  readonly pinned: string[];
  readonly favorites: string[];
}

export interface CollectionFields {
  readonly name?: string;
  readonly description?: string | null;
  readonly icon?: string | null;
  readonly color?: string | null;
  readonly isFavorite?: boolean;
  readonly isExpanded?: boolean;
}

export async function readCollections(
  db: Executor,
  oxyUserId: string,
): Promise<CollectionsSnapshot> {
  const [rows, items, marked] = await Promise.all([
    db
      .select()
      .from(conversationCollections)
      .where(eq(conversationCollections.oxyUserId, oxyUserId))
      .orderBy(asc(conversationCollections.createdAt), asc(conversationCollections.id)),
    db
      .select({
        collectionId: conversationCollectionItems.collectionId,
        conversationId: conversationCollectionItems.conversationId,
      })
      .from(conversationCollectionItems)
      .where(eq(conversationCollectionItems.oxyUserId, oxyUserId))
      .orderBy(asc(conversationCollectionItems.createdAt), asc(conversationCollectionItems.id)),
    db
      .select({
        conversationId: conversations.conversationId,
        pinnedAt: conversations.pinnedAt,
        isFavorite: conversations.isFavorite,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.oxyUserId, oxyUserId),
          sql`(${conversations.pinnedAt} is not null or ${conversations.isFavorite})`,
        ),
      )
      .orderBy(asc(conversations.pinnedAt)),
  ]);
  const members = new Map<string, string[]>();
  for (const item of items) {
    const list = members.get(item.collectionId) ?? [];
    list.push(item.conversationId);
    members.set(item.collectionId, list);
  }
  return {
    collections: rows.map((row) => ({
      id: row.id,
      kind: row.kind as ConversationCollectionKind,
      name: row.name,
      description: row.description,
      icon: row.icon,
      color: row.color,
      isFavorite: row.isFavorite,
      isExpanded: row.isExpanded,
      conversationIds: members.get(row.id) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    pinned: marked.filter((row) => row.pinnedAt !== null).map((row) => row.conversationId),
    favorites: marked.filter((row) => row.isFavorite).map((row) => row.conversationId),
  };
}

export async function countCollections(db: Executor, oxyUserId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversationCollections)
    .where(eq(conversationCollections.oxyUserId, oxyUserId));
  return row?.count ?? 0;
}

export async function createCollection(
  db: Executor,
  oxyUserId: string,
  input: { kind: ConversationCollectionKind; name: string } & CollectionFields,
): Promise<string> {
  const [row] = await db
    .insert(conversationCollections)
    .values({
      oxyUserId,
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      isFavorite: input.isFavorite ?? false,
      isExpanded: input.isExpanded ?? true,
    })
    .returning({ id: conversationCollections.id });
  if (!row) throw new Error('collection insert returned no row');
  return row.id;
}

/** Reports whether a collection of the person's matched. */
export async function updateCollection(
  db: Executor,
  oxyUserId: string,
  id: string,
  fields: CollectionFields,
): Promise<boolean> {
  const rows = await db
    .update(conversationCollections)
    .set({
      ...(fields.name === undefined ? {} : { name: fields.name }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.icon === undefined ? {} : { icon: fields.icon }),
      ...(fields.color === undefined ? {} : { color: fields.color }),
      ...(fields.isFavorite === undefined ? {} : { isFavorite: fields.isFavorite }),
      ...(fields.isExpanded === undefined ? {} : { isExpanded: fields.isExpanded }),
      updatedAt: new Date(),
    })
    .where(
      and(eq(conversationCollections.oxyUserId, oxyUserId), eq(conversationCollections.id, id)),
    )
    .returning({ id: conversationCollections.id });
  return rows.length > 0;
}

/** Its memberships go with it (the foreign key cascades). */
export async function deleteCollection(
  db: Executor,
  oxyUserId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(conversationCollections)
    .where(
      and(eq(conversationCollections.oxyUserId, oxyUserId), eq(conversationCollections.id, id)),
    )
    .returning({ id: conversationCollections.id });
  return rows.length > 0;
}

/** File conversations in a collection of the person's; idempotent. Reports whether it matched. */
export async function addToCollection(
  db: Executor,
  oxyUserId: string,
  collectionId: string,
  conversationIds: readonly string[],
): Promise<boolean> {
  const [owned] = await db
    .select({ id: conversationCollections.id })
    .from(conversationCollections)
    .where(
      and(
        eq(conversationCollections.oxyUserId, oxyUserId),
        eq(conversationCollections.id, collectionId),
      ),
    );
  if (!owned) return false;
  if (conversationIds.length === 0) return true;
  await db
    .insert(conversationCollectionItems)
    .values(conversationIds.map((conversationId) => ({ collectionId, oxyUserId, conversationId })))
    .onConflictDoNothing();
  return true;
}

export async function removeFromCollection(
  db: Executor,
  oxyUserId: string,
  collectionId: string,
  conversationId: string,
): Promise<void> {
  await db
    .delete(conversationCollectionItems)
    .where(
      and(
        eq(conversationCollectionItems.oxyUserId, oxyUserId),
        eq(conversationCollectionItems.collectionId, collectionId),
        eq(conversationCollectionItems.conversationId, conversationId),
      ),
    );
}

/**
 * Pin or favourite conversations of the person's. `updated_at` does not move: a mark is not
 * activity. Ids that name no conversation of theirs change nothing. Returns how many matched.
 */
export async function markConversations(
  db: ApiDatabase | Executor,
  oxyUserId: string,
  conversationIds: readonly string[],
  marks: { readonly pinned?: boolean; readonly favorite?: boolean },
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  if (marks.pinned === undefined && marks.favorite === undefined) return 0;
  const rows = await db
    .update(conversations)
    .set({
      ...(marks.pinned === undefined
        ? {}
        : {
            pinnedAt: marks.pinned ? sql`coalesce(${conversations.pinnedAt}, now())` : sql`null`,
          }),
      ...(marks.favorite === undefined ? {} : { isFavorite: marks.favorite }),
      updatedAt: sql`${conversations.updatedAt}`,
    })
    .where(
      and(
        eq(conversations.oxyUserId, oxyUserId),
        inArray(conversations.conversationId, [...conversationIds]),
      ),
    )
    .returning({ id: conversations.id });
  return rows.length;
}

/** The person's collections of one kind, by name (case-insensitive): what an import merges into. */
export async function collectionsByName(
  db: Executor,
  oxyUserId: string,
  kind: ConversationCollectionKind,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: conversationCollections.id, name: conversationCollections.name })
    .from(conversationCollections)
    .where(
      and(
        eq(conversationCollections.oxyUserId, oxyUserId),
        eq(conversationCollections.kind, kind),
        isNotNull(conversationCollections.name),
      ),
    )
    .orderBy(asc(conversationCollections.createdAt));
  const byName = new Map<string, string>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, row.id);
  }
  return byName;
}

export interface ImportedCollection {
  readonly name: string;
  readonly description?: string | null;
  readonly icon?: string | null;
  readonly color?: string | null;
  readonly isFavorite?: boolean;
  readonly isExpanded?: boolean;
  readonly conversationIds: readonly string[];
}

/**
 * What a device filed before collections were the account's joins the account's, in one
 * transaction. Merging, so a second device brings its own: a folder or project with the same name
 * (any case) receives the conversations instead of being made twice, a conversation already filed
 * stays filed once, and the account's limit is never passed.
 */
export async function importCollections(
  db: ApiDatabase,
  oxyUserId: string,
  input: {
    readonly pinned: readonly string[];
    readonly favorites: readonly string[];
    readonly folders: readonly ImportedCollection[];
    readonly projects: readonly ImportedCollection[];
  },
  limit: number = COLLECTION_LIMITS.perAccount,
): Promise<void> {
  await db.transaction(async (tx) => {
    await markConversations(tx, oxyUserId, input.pinned, { pinned: true });
    await markConversations(tx, oxyUserId, input.favorites, { favorite: true });
    let count = await countCollections(tx, oxyUserId);
    for (const [kind, list] of [
      ['folder', input.folders],
      ['project', input.projects],
    ] as const) {
      const byName = await collectionsByName(tx, oxyUserId, kind);
      for (const item of list) {
        const key = item.name.trim().toLowerCase();
        let id = byName.get(key);
        if (id === undefined) {
          if (count >= limit) continue;
          id = await createCollection(tx, oxyUserId, {
            kind,
            name: item.name.trim(),
            description: item.description ?? null,
            icon: item.icon ?? null,
            color: item.color ?? null,
            ...(item.isFavorite === undefined ? {} : { isFavorite: item.isFavorite }),
            ...(item.isExpanded === undefined ? {} : { isExpanded: item.isExpanded }),
          });
          byName.set(key, id);
          count += 1;
        }
        await addToCollection(tx, oxyUserId, id, [...new Set(item.conversationIds)]);
      }
    }
  });
}
