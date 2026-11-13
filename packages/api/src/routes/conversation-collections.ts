/**
 * `/conversations/collections` (and `/v1/…`): a person's folders and projects, on their account so
 * every device files the same, and `PATCH /conversations/:id` for the pin and the favourite
 * (`docs/realtime.mdx`, "Collections"). A person's session only. Every write answers the whole
 * snapshot and publishes it as the realtime `collections` event.
 */

import { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import {
  addToCollection,
  countCollections,
  createCollection,
  deleteCollection,
  importCollections,
  markConversations,
  readCollections,
  removeFromCollection,
  updateCollection,
} from '../db/chat/collectionRepository.js';
import { getDb } from '../db/index.js';
import {
  COLLECTION_LIMITS,
  CONVERSATION_COLLECTION_KINDS,
} from '../domain/conversation-collections.js';
import { log } from '../lib/logger.js';
import { publishCollections } from '../lib/realtime/collections.js';
import { authenticateToken } from '../middleware/auth.js';

const L = COLLECTION_LIMITS;
const conversationId = z.string().min(1).max(256);
const fields = {
  name: z.string().trim().min(1).max(L.nameChars),
  description: z.string().max(L.descriptionChars).nullable(),
  icon: z.string().max(L.iconChars).nullable(),
  color: z.string().max(L.colorChars).nullable(),
  isFavorite: z.boolean(),
  isExpanded: z.boolean(),
};
const createSchema = z
  .object({
    kind: z.enum(CONVERSATION_COLLECTION_KINDS),
    name: fields.name,
    description: fields.description.optional(),
    icon: fields.icon.optional(),
    color: fields.color.optional(),
  })
  .strict();
const updateSchema = z
  .object({
    name: fields.name.optional(),
    description: fields.description.optional(),
    icon: fields.icon.optional(),
    color: fields.color.optional(),
    isFavorite: fields.isFavorite.optional(),
    isExpanded: fields.isExpanded.optional(),
  })
  .strict();
const importedCollection = z.object({
  name: fields.name,
  description: z.string().max(L.descriptionChars).nullish(),
  icon: z.string().max(L.iconChars).nullish(),
  color: z.string().max(L.colorChars).nullish(),
  isFavorite: z.boolean().optional(),
  isExpanded: z.boolean().optional(),
  conversationIds: z.array(conversationId).max(L.importConversations),
});
const importSchema = z
  .object({
    pinned: z.array(conversationId).max(L.importConversations).default([]),
    favorites: z.array(conversationId).max(L.importConversations).default([]),
    folders: z.array(importedCollection).max(L.perAccount).default([]),
    projects: z.array(importedCollection).max(L.perAccount).default([]),
  })
  .strict();
const marksSchema = z
  .object({ pinned: z.boolean().optional(), favorite: z.boolean().optional() })
  .strict()
  .refine((value) => value.pinned !== undefined || value.favorite !== undefined);

const fail = (res: Response, err: unknown, what: string) => {
  log.chat.error({ err }, what);
  res.status(500).json({ error: `${what} failed` });
};

/** Mounted under the conversations router, before its `/:id` routes. */
export const collectionsRouter = Router();

collectionsRouter.get('/', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json(await readCollections(getDb(), req.user.id));
  } catch (err) {
    fail(res, err, 'Reading collections');
  }
});

collectionsRouter.post('/', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid collection' });
  try {
    if ((await countCollections(getDb(), req.user.id)) >= L.perAccount) {
      return res.status(409).json({ error: 'Too many collections', code: 'collection_limit' });
    }
    const id = await createCollection(getDb(), req.user.id, parsed.data);
    res.status(201).json({ id, ...(await publishCollections(req.user.id)) });
  } catch (err) {
    fail(res, err, 'Creating a collection');
  }
});

/**
 * The first time a device signs in with what it filed before collections were the account's: its
 * pins, favourites, folders and projects join the account's. Merging, so a second device brings
 * its own: a folder or project with the same name (any case) receives the conversations instead
 * of being made twice, and a conversation already filed stays filed once.
 */
collectionsRouter.post('/import', authenticateToken, async (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid import' });
  const userId = req.user.id;
  try {
    await importCollections(getDb(), userId, parsed.data);
    res.json(await publishCollections(userId));
  } catch (err) {
    fail(res, err, 'Importing collections');
  }
});

collectionsRouter.patch(
  '/:collectionId',
  authenticateToken,
  async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid collection' });
    try {
      if (
        !(await updateCollection(
          getDb(),
          req.user.id,
          String(req.params.collectionId),
          parsed.data,
        ))
      )
        return res.status(404).json({ error: 'Collection not found' });
      res.json(await publishCollections(req.user.id));
    } catch (err) {
      fail(res, err, 'Updating a collection');
    }
  },
);

collectionsRouter.delete(
  '/:collectionId',
  authenticateToken,
  async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    try {
      if (!(await deleteCollection(getDb(), req.user.id, String(req.params.collectionId))))
        return res.status(404).json({ error: 'Collection not found' });
      res.json(await publishCollections(req.user.id));
    } catch (err) {
      fail(res, err, 'Deleting a collection');
    }
  },
);

collectionsRouter.put(
  '/:collectionId/conversations/:conversationId',
  authenticateToken,
  async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const id = conversationId.safeParse(req.params.conversationId);
    if (!id.success) return res.status(400).json({ error: 'Invalid conversation' });
    try {
      if (
        !(await addToCollection(getDb(), req.user.id, String(req.params.collectionId), [id.data]))
      )
        return res.status(404).json({ error: 'Collection not found' });
      res.json(await publishCollections(req.user.id));
    } catch (err) {
      fail(res, err, 'Filing a conversation');
    }
  },
);

collectionsRouter.delete(
  '/:collectionId/conversations/:conversationId',
  authenticateToken,
  async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    try {
      await removeFromCollection(
        getDb(),
        req.user.id,
        String(req.params.collectionId),
        String(req.params.conversationId),
      );
      res.json(await publishCollections(req.user.id));
    } catch (err) {
      fail(res, err, 'Unfiling a conversation');
    }
  },
);

/** `PATCH /conversations/:id { pinned?, favorite? }`: the conversation's own marks. */
export async function patchConversationMarks(req: Request, res: Response) {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = marksSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'pinned or favorite, as booleans' });
  try {
    const matched = await markConversations(
      getDb(),
      req.user.id,
      [String(req.params.id)],
      parsed.data,
    );
    if (matched === 0) return res.status(404).json({ error: 'Conversation not found' });
    res.json(await publishCollections(req.user.id));
  } catch (err) {
    fail(res, err, 'Marking a conversation');
  }
}
