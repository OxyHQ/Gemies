import { type Store, withStore } from '@oxy.so/bloom-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every write of the runtime is an action with an optimistic layer: the change shows at once, while
 * the server is asked, and when the server refuses the layer goes and the account's store is
 * exactly as it was (the rollback). Each case holds the request open, looks at the store, then
 * refuses it.
 */

vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({}) }));

import {
  connectedAccounts,
  grantAccount,
  removeAccount,
  updateAccount,
} from '../../src/runtime/connected-accounts';
import { connections, disconnectConnector, renameConnector } from '../../src/runtime/connectors';
import {
  conversationCollections,
  createCollection,
  deleteCollection,
  setCollectionMember,
  setConversationFavorite,
  setConversationPinned,
  updateCollection,
} from '../../src/runtime/data/collections';
import {
  type ConversationsClient,
  deleteConversation,
  markConversationRead,
  OfflineConversations,
  saveConversation,
} from '../../src/runtime/data/conversations';
import { ACCOUNT } from '../../src/runtime/data/read';
import type { GemieApi } from '../../src/runtime/api';
import { freshStore, heldConversation, listIds, seedList } from '../support/data-store';

/** Every write waits for `release`, then is refused with a 500. */
let release: () => void;
let held: Promise<void>;
const refusing = async (): Promise<never> => {
  await held;
  throw Object.assign(new Error('refused'), { status: 500 });
};
const api = {
  get: vi.fn(async () => ({ status: 200, data: {} })),
  post: vi.fn(refusing),
  patch: vi.fn(refusing),
  put: vi.fn(refusing),
  delete: vi.fn(refusing),
} as unknown as GemieApi;
const client: ConversationsClient = {
  api,
  offline: new OfflineConversations(null),
  newChatTitle: 'New chat',
  app: undefined,
  realtime: null,
};

let store: Store;
const read = <T>(fn: () => T): T => withStore(store, fn);

/** Starts a write, lets its layer show, and returns how to refuse it and wait for the rollback. */
function start(write: () => Promise<unknown>) {
  const done = read(write).catch((error: unknown) => error);
  return async () => {
    release();
    // A runtime write retries once, a second later, before it gives up.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await done).toBeInstanceOf(Error);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  held = new Promise((resolve) => {
    release = resolve;
  });
  store = freshStore();
  seedList(store, [
    {
      id: 'c1',
      title: 'Capitals',
      unreadCount: 2,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
      messages: [{ id: 'm1', role: 'user', content: 'hola' }],
    },
    {
      id: 'c2',
      title: 'Other',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a conversation write the server refuses', () => {
  it('delete: the row leaves every list at once, and comes back', async () => {
    const refuse = start(() => deleteConversation(client, 'c1'));
    expect(listIds(store)).toEqual(['c2']);
    await refuse();
    expect(listIds(store)).toEqual(['c1', 'c2']);
    expect(heldConversation(store, 'c1')?.title).toBe('Capitals');
  });

  it('save: the messages show at once, and the held ones come back', async () => {
    const refuse = start(() =>
      saveConversation(client, {
        id: 'c1',
        title: 'Renamed',
        messages: [{ id: 'm9', role: 'user', content: 'new' }],
      }),
    );
    expect(heldConversation(store, 'c1')).toMatchObject({ title: 'Renamed' });
    expect(heldConversation(store, 'c1')?.messages?.map((m) => m.id)).toEqual(['m9']);
    await refuse();
    expect(heldConversation(store, 'c1')?.title).toBe('Capitals');
    expect(heldConversation(store, 'c1')?.messages?.map((m) => m.id)).toEqual(['m1']);
  });

  it('read: the unread count is zero at once, and comes back', async () => {
    const done = read(() => markConversationRead(client, 'c1')).catch((error: unknown) => error);
    expect(heldConversation(store, 'c1')?.unreadCount).toBe(0);
    release();
    expect(await done).toBeInstanceOf(Error);
    expect(heldConversation(store, 'c1')?.unreadCount).toBe(2);
  });
});

describe('a collections write the server refuses', () => {
  const snapshot = {
    collections: [
      {
        id: 'work',
        kind: 'folder' as const,
        name: 'Work',
        description: null,
        icon: null,
        color: null,
        isFavorite: false,
        isExpanded: true,
        conversationIds: ['c1'],
        createdAt: '2026-11-13T10:00:00.000Z',
        updatedAt: '2026-11-13T10:00:00.000Z',
      },
    ],
    pinned: ['c2'],
    favorites: [],
  };
  const value = () => read(() => conversationCollections.entity.get(ACCOUNT)?.value);

  it.each([
    ['create', () => createCollection(api, 'folder', { name: 'Home' })],
    ['update', () => updateCollection(api, 'work', { name: 'Job' })],
    ['delete', () => deleteCollection(api, 'work')],
    ['file', () => setCollectionMember(api, 'work', 'c2', true)],
    ['unfile', () => setCollectionMember(api, 'work', 'c1', false)],
    ['pin', () => setConversationPinned(api, 'c1', true)],
    ['favourite', () => setConversationFavorite(api, 'c1', true)],
  ])('%s: drawn at once, and put back', async (_name, write) => {
    read(() => conversationCollections.entity.put({ id: ACCOUNT, value: snapshot }));
    const before = value();
    const refuse = start(write);
    expect(value()).not.toEqual(before);
    await refuse();
    expect(value()).toEqual(snapshot);
  });
});

describe('a connected-account write the server refuses', () => {
  const answer = {
    accounts: [
      {
        _id: 'acc-1',
        platform: 'whatsapp' as const,
        displayName: null,
        phoneNumber: '+34 600',
        status: 'connected' as const,
        canReply: null,
        gemieIds: ['alia'],
        answeringGemieId: null,
        replies: 'everyone' as const,
        replyChatIds: [],
        groupReplies: 'mentions' as const,
        lastActiveAt: null,
      },
    ],
    gemies: [{ id: 'alia', name: 'Alia' }],
    platforms: ['whatsapp' as const],
  };
  const value = () => read(() => connectedAccounts.entity.get(ACCOUNT)?.value);

  it.each([
    ['who answers', () => updateAccount(api, 'acc-1', { answeringGemieId: 'alia' })],
    ['a grant', () => grantAccount(api, 'acc-1', 'scout', true)],
    ['a revoke', () => grantAccount(api, 'acc-1', 'alia', false)],
    ['removing it', () => removeAccount(api, 'acc-1')],
  ])('%s: drawn at once, and put back', async (_name, write) => {
    read(() => connectedAccounts.entity.put({ id: ACCOUNT, value: answer }));
    const refuse = start(write);
    expect(value()).not.toEqual(answer);
    await refuse();
    expect(value()).toEqual(answer);
  });
});

describe('a connector write the server refuses', () => {
  const held = [
    {
      _id: 'n1',
      name: 'notion',
      displayName: 'Notion',
      description: null,
      accountLabel: null,
      source: 'registry' as const,
      registryId: 'notion',
      config: {},
      status: 'running' as const,
      statusMessage: null,
      tools: [],
      logoUrl: null,
      usedBy: [],
    },
  ];
  const value = () => read(() => connections.entity.get(ACCOUNT)?.value);

  it.each([
    ['a rename', () => renameConnector(api, 'n1', 'Work')],
    ['a disconnect', () => disconnectConnector(api, 'n1')],
  ])('%s: drawn at once, and put back', async (_name, write) => {
    read(() => connections.entity.put({ id: ACCOUNT, value: held }));
    const refuse = start(write);
    expect(value()).not.toEqual(held);
    await refuse();
    expect(value()).toEqual(held);
  });
});
