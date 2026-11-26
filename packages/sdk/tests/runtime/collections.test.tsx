import { DataProvider, type Store, withStore } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A person's folders, projects, pins and favourites (`src/runtime/collections.ts`): read once,
 * changed at once on screen and replaced by what the server answers, put back when the server
 * refuses, and replaced whole by the realtime `collections` snapshot another device caused.
 */

const wire = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body?: unknown }>,
  fail: false,
  /** A write waits on this when set, so a test can look at the screen before the answer. */
  hold: null as Promise<void> | null,
  snapshot: { collections: [] as unknown[], pinned: [] as string[], favorites: [] as string[] },
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ canUsePrivateApi: true }),
}));
vi.mock('../../src/runtime/api', () => {
  const answer = (method: string) => async (path: string, body?: unknown) => {
    // A read's second argument is its request (a signal), not a body.
    const sent = method === 'get' || method === 'delete' ? undefined : body;
    wire.calls.push({ method, path, ...(sent === undefined ? {} : { body: sent }) });
    if (method !== 'get' && wire.hold) await wire.hold;
    if (wire.fail && method !== 'get') throw new Error('refused');
    return { status: 200, data: wire.snapshot };
  };
  const api = {
    get: answer('get'),
    post: answer('post'),
    patch: answer('patch'),
    put: answer('put'),
    delete: answer('delete'),
  };
  return { useGemieApi: () => api };
});

import { applyRealtimeFrame } from '../../src/realtime/store';
import type { RealtimeFrame } from '../../src/realtime/contract';
import {
  type CollectionActions,
  type ConversationCollections,
  useCollectionActions,
  useConversationCollections,
} from '../../src/runtime/collections';
import { freshStore } from '../support/data-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let store: Store;
let renderer: ReactTestRenderer | undefined;
let seen: ConversationCollections;
let actions: CollectionActions;

/** The store tells its readers after the write; a tick lets React render it. */
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function Probe() {
  seen = useConversationCollections();
  actions = useCollectionActions();
  return null;
}

const folder = (id: string, conversationIds: string[] = []) => ({
  id,
  kind: 'folder',
  name: id,
  description: null,
  icon: null,
  color: null,
  isFavorite: false,
  isExpanded: true,
  conversationIds,
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
});

beforeEach(async () => {
  wire.calls = [];
  wire.fail = false;
  wire.hold = null;
  wire.snapshot = { collections: [folder('work')], pinned: ['a'], favorites: [] };
  store = freshStore();
  await act(async () => {
    renderer = create(
      <DataProvider store={store}>
        <Probe />
      </DataProvider>,
    );
  });
  // The first read lands.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
});

describe('the account collections', () => {
  it('draws a change at once, before the server answers', async () => {
    let release!: () => void;
    wire.hold = new Promise((resolve) => {
      release = resolve;
    });
    wire.snapshot = { ...wire.snapshot, favorites: ['a'] };
    let done!: Promise<void>;
    act(() => {
      done = actions.setFavorite('a', true);
    });
    expect(seen.favorites).toEqual(['a']);
    await act(async () => {
      release();
      await done;
    });
    expect(seen.favorites).toEqual(['a']);
  });

  it('reads the snapshot once', () => {
    expect(seen.collections.map((c) => c.id)).toEqual(['work']);
    expect(seen.pinned).toEqual(['a']);
    expect(wire.calls).toEqual([{ method: 'get', path: '/v1/conversations/collections' }]);
  });

  it('draws a pin at once and keeps what the server answers', async () => {
    wire.snapshot = { ...wire.snapshot, pinned: ['a', 'b'] };
    await act(async () => {
      await actions.setPinned('b', true);
    });
    await tick();
    expect(seen.pinned).toEqual(['a', 'b']);
    expect(wire.calls.at(-1)).toEqual({
      method: 'patch',
      path: '/v1/conversations/b',
      body: { pinned: true },
    });
  });

  it('files a conversation and reads the server back when a change is refused', async () => {
    wire.fail = true;
    await act(async () => {
      await actions.addToCollection('work', 'c1').catch(() => undefined);
    });
    await tick();
    await tick();
    expect(
      wire.calls.some((c) => c.method === 'put' && c.path.endsWith('/work/conversations/c1')),
    ).toBe(true);
    // Refused: the change's layer goes, and the server's state (no c1) shows again.
    expect(seen.collections[0]?.conversationIds).toEqual([]);
  });

  it('takes another device’s change whole, from the realtime snapshot', async () => {
    act(() =>
      withStore(store, () =>
        applyRealtimeFrame({
          v: 1,
          type: 'collections',
          seq: 4,
          data: {
            collections: [folder('work', ['c9']), folder('home')],
            pinned: [],
            favorites: ['z'],
          },
        } as RealtimeFrame),
      ),
    );
    await tick();
    expect(seen.collections.map((c) => [c.id, c.conversationIds])).toEqual([
      ['work', ['c9']],
      ['home', []],
    ]);
    expect(seen).toMatchObject({ pinned: [], favorites: ['z'] });
  });
});
