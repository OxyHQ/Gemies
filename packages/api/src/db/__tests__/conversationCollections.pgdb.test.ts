import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  addToCollection,
  collectionsByName,
  createCollection,
  deleteCollection,
  importCollections,
  markConversations,
  readCollections,
  removeFromCollection,
  updateCollection,
} from '../chat/collectionRepository';
import {
  deleteConversation,
  findConversation,
  upsertConversation,
} from '../chat/conversationRepository';

/**
 * A person's folders, projects, pins and favourites on their account (`db/schema/collections.ts`),
 * on a real Postgres: what one device files every other reads back, nobody else sees it, a mark
 * does not reorder the list, and a deleted conversation leaves every folder.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const account = () => `user-${randomUUID()}`;
const conversation = (oxyUserId: string, conversationId: string) =>
  upsertConversation(db, { oxyUserId, conversationId, titleOnInsert: 'x', agentId: 'alia' });

describe('collections', () => {
  it('files conversations in folders and projects, once each, for their owner only', async () => {
    const me = account();
    const folder = await createCollection(db, me, {
      kind: 'folder',
      name: 'Trabajo',
      icon: 'Folder',
    });
    const project = await createCollection(db, me, {
      kind: 'project',
      name: 'Viaje',
      description: 'Julio',
    });
    expect(await addToCollection(db, me, folder, ['c1', 'c2', 'c1'])).toBe(true);
    expect(await addToCollection(db, me, project, ['c2'])).toBe(true);
    // Someone else's collection is not there to file into.
    expect(await addToCollection(db, account(), folder, ['c9'])).toBe(false);
    expect(await updateCollection(db, account(), folder, { name: 'mío' })).toBe(false);

    await updateCollection(db, me, folder, { isExpanded: false, isFavorite: true });
    await removeFromCollection(db, me, folder, 'c1');
    const snapshot = await readCollections(db, me);
    expect(
      snapshot.collections.map((c) => [
        c.kind,
        c.name,
        c.conversationIds,
        c.isExpanded,
        c.isFavorite,
      ]),
    ).toEqual([
      ['folder', 'Trabajo', ['c2'], false, true],
      ['project', 'Viaje', ['c2'], true, false],
    ]);
    expect((await readCollections(db, account())).collections).toEqual([]);

    expect(await deleteCollection(db, me, folder)).toBe(true);
    expect((await readCollections(db, me)).collections.map((c) => c.name)).toEqual(['Viaje']);
  });

  it('pins and favourites a conversation without moving it in the list', async () => {
    const me = account();
    await conversation(me, 'a');
    await conversation(me, 'b');
    const before = (await findConversation(db, me, 'a'))?.updatedAt;
    expect(await markConversations(db, me, ['a'], { pinned: true, favorite: true })).toBe(1);
    await markConversations(db, me, ['b'], { pinned: true });
    // Pinning again keeps the first pin's place.
    await markConversations(db, me, ['a'], { pinned: true });
    expect(await markConversations(db, account(), ['a'], { pinned: true })).toBe(0);
    expect((await findConversation(db, me, 'a'))?.updatedAt.getTime()).toBe(before?.getTime());
    expect(await readCollections(db, me)).toMatchObject({ pinned: ['a', 'b'], favorites: ['a'] });
    await markConversations(db, me, ['a'], { pinned: false, favorite: false });
    expect(await readCollections(db, me)).toMatchObject({ pinned: ['b'], favorites: [] });
  });

  it('takes a deleted conversation out of every folder', async () => {
    const me = account();
    await conversation(me, 'gone');
    const folder = await createCollection(db, me, { kind: 'folder', name: 'F' });
    await addToCollection(db, me, folder, ['gone', 'kept']);
    await deleteConversation(db, me, 'gone');
    expect((await readCollections(db, me)).collections[0]?.conversationIds).toEqual(['kept']);
  });

  it('finds a collection by name in any case, for an import to merge into', async () => {
    const me = account();
    const id = await createCollection(db, me, { kind: 'folder', name: ' Trabajo ' });
    expect((await collectionsByName(db, me, 'folder')).get('trabajo')).toBe(id);
    expect((await collectionsByName(db, me, 'project')).size).toBe(0);
  });

  it('merges what each device filed before, by name, without doubling anything', async () => {
    const me = account();
    await conversation(me, 'p1');
    await conversation(me, 'f1');
    const phone = {
      pinned: ['p1', 'nonexistent'],
      favorites: ['f1'],
      folders: [{ name: 'Trabajo', conversationIds: ['c1', 'c2'] }],
      projects: [{ name: 'Viaje', description: 'Julio', conversationIds: ['c3'] }],
    };
    const laptop = {
      pinned: [],
      favorites: [],
      folders: [
        { name: 'trabajo ', conversationIds: ['c2', 'c4'] },
        { name: 'Casa', conversationIds: [] },
      ],
      projects: [],
    };
    await importCollections(db, me, phone);
    await importCollections(db, me, laptop);
    await importCollections(db, me, phone);
    const snapshot = await readCollections(db, me);
    expect(
      snapshot.collections.map((c) => [c.kind, c.name, [...c.conversationIds].sort()]),
    ).toEqual([
      ['folder', 'Trabajo', ['c1', 'c2', 'c4']],
      ['project', 'Viaje', ['c3']],
      ['folder', 'Casa', []],
    ]);
    expect(snapshot).toMatchObject({ pinned: ['p1'], favorites: ['f1'] });
  });

  it('never imports past the account limit', async () => {
    const me = account();
    await importCollections(
      db,
      me,
      {
        pinned: [],
        favorites: [],
        folders: ['a', 'b', 'c'].map((name) => ({ name, conversationIds: [] })),
        projects: [],
      },
      2,
    );
    expect((await readCollections(db, me)).collections.map((c) => c.name)).toEqual(['a', 'b']);
  });
});
