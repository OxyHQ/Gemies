/**
 * A person's own ways of filing their conversations, kept on their account so every device shows
 * the same (`db/schema/collections.ts`): folders and projects that group conversations, and the
 * pin and favourite marks on a conversation.
 */
export const CONVERSATION_COLLECTION_KINDS = ['folder', 'project'] as const;
export type ConversationCollectionKind = (typeof CONVERSATION_COLLECTION_KINDS)[number];

/** Bounds a client cannot exceed: what fits a sidebar, not a limit anybody reaches by hand. */
export const COLLECTION_LIMITS = {
  perAccount: 200,
  nameChars: 80,
  descriptionChars: 500,
  iconChars: 40,
  colorChars: 32,
  /** A first sign-in may bring every local pin and folder at once. */
  importConversations: 2000,
} as const;
