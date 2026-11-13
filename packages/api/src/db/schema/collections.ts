/**
 * Folders and projects: how a person files their conversations, on their account rather than on a
 * device (`docs/realtime.mdx`, "Collections"). Every surface of the person reads the same, and a
 * change reaches the others as the realtime `collections` event.
 *
 * A collection names conversations by their business key (`conversations.conversation_id`, unique
 * per owner), with no foreign key for the reason `messages` has none: the conversation row and
 * what refers to it are written by different requests. Deleting a conversation removes its
 * memberships in the same transaction (`deleteConversation`).
 *
 * The pin and the favourite are not collections: they are marks on the conversation itself
 * (`conversations.pinned_at`, `conversations.is_favorite`).
 */

import { boolean, foreignKey, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { CONVERSATION_COLLECTION_KINDS } from '../../domain/conversation-collections.js';
import { checkOneOf } from './columns';

export const conversationCollections = pgTable(
  'conversation_collections',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    kind: text({
      enum: CONVERSATION_COLLECTION_KINDS as unknown as [string, ...string[]],
    }).notNull(),
    name: text().notNull(),
    /** A project's description; a folder has none. */
    description: text(),
    icon: text(),
    color: text(),
    isFavorite: boolean().notNull().default(false),
    /** Open in the sidebar. Kept with the collection so a person's arrangement follows them. */
    isExpanded: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('conversation_collections_oxy_user_created_at_idx').on(t.oxyUserId, t.createdAt),
    checkOneOf('conversation_collections_kind_check', t.kind, CONVERSATION_COLLECTION_KINDS),
  ],
);

export const conversationCollectionItems = pgTable(
  'conversation_collection_items',
  {
    id: generatedId(),
    collectionId: text().notNull(),
    /** The collection's owner, repeated so a conversation's memberships are found by its key. */
    oxyUserId: text().notNull(),
    conversationId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'conversation_collection_items_collection_id_fk',
      columns: [t.collectionId],
      foreignColumns: [conversationCollections.id],
    }).onDelete('cascade'),
    uniqueIndex('conversation_collection_items_collection_conversation_key').on(
      t.collectionId,
      t.conversationId,
    ),
    // A conversation deleted: its memberships go with it.
    index('conversation_collection_items_oxy_user_conversation_idx').on(
      t.oxyUserId,
      t.conversationId,
    ),
  ],
);
