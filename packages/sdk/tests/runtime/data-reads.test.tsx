import { DataProvider, Store } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The account's reads beside the conversations (collections, an agent's profile and features, the
 * connections): each waits for the private API, lives in the signed-in account's store (so a
 * switch never shows the previous account's), drops an answer for an account that was left, and
 * keeps the rules its React Query read had (how long it is fresh, what is retried).
 */

const session = vi.hoisted(() => ({ ready: true }));
const wire = vi.hoisted(() => ({
  gets: [] as string[],
  /** What a GET answers; a promise holds it open. */
  answer: (_path: string): unknown => ({}),
}));

vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, canUsePrivateApi: session.ready }),
}));
vi.mock('../../src/runtime/api', () => {
  const api = {
    get: async (path: string) => {
      wire.gets.push(path);
      return { status: 200, data: await wire.answer(path) };
    },
  };
  return { useGemieApi: () => api };
});

import { useAgentFeatures, useAgentProfile } from '../../src/runtime/agents';
import { useConversationCollections } from '../../src/runtime/collections';
import { useConnections } from '../../src/runtime/connectors';
import { retriesRead } from '../../src/runtime/data/read';
import { retryThreadRead } from '../../src/runtime/data/threads';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const snapshot = (pinned: string[]) => ({ collections: [], pinned, favorites: [] });

let renderer: ReactTestRenderer | undefined;
let store: Store;
let show = true;
let probe: () => void = () => undefined;
function Probe() {
  probe();
  return null;
}
const tree = () => <DataProvider store={store}>{show ? <Probe /> : null}</DataProvider>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
async function mount(use: () => void) {
  probe = use;
  store = new Store();
  await act(async () => {
    renderer = create(tree());
  });
  await settle();
}
const rerender = () => act(async () => renderer?.update(tree()));
/** Services closes the account's store and opens the next account's. */
async function switchAccount() {
  const left = store;
  store = new Store();
  await left.close();
  await rerender();
}

beforeEach(() => {
  session.ready = true;
  show = true;
  wire.gets = [];
  wire.answer = (path) => (path.endsWith('/collections') ? snapshot(['a']) : {});
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('waiting for the private API', () => {
  it('reads nothing until it is usable, then reads at once', async () => {
    session.ready = false;
    await mount(() => {
      useConversationCollections();
      useConnections();
      useAgentProfile('pepe');
      useAgentFeatures('pepe');
    });
    expect(wire.gets).toEqual([]);
    session.ready = true;
    await rerender();
    await settle();
    expect([...wire.gets].sort()).toEqual([
      '/mcp/installed',
      '/v1/agents/pepe/features',
      '/v1/agents/pepe/profile',
      '/v1/conversations/collections',
    ]);
  });
});

describe('the collections across an account switch', () => {
  it("never shows the previous account's", async () => {
    const seen: string[][] = [];
    await mount(() => {
      seen.push([...useConversationCollections().pinned]);
    });
    expect(seen.at(-1)).toEqual(['a']);
    wire.answer = () => snapshot(['b']);
    const before = seen.length;
    await switchAccount();
    await settle();
    expect(seen.at(-1)).toEqual(['b']);
    expect(seen.slice(before).flat()).not.toContain('a');
  });

  it('drops an answer that lands for the account that was left', async () => {
    let answerFirst!: () => void;
    wire.answer = () =>
      new Promise((resolve) => {
        answerFirst = () => resolve(snapshot(['a']));
      });
    let seen: readonly string[] = [];
    await mount(() => {
      seen = useConversationCollections().pinned;
    });
    wire.answer = () => snapshot(['b']);
    await switchAccount();
    await settle();
    answerFirst();
    await settle();
    expect(seen).toEqual(['b']);
  });
});

describe('how long a read is fresh', () => {
  it("does not read an agent's profile again when a chat opens on it again, but reads its features", async () => {
    await mount(() => {
      useAgentProfile('pepe');
      useAgentFeatures('pepe');
    });
    show = false;
    await rerender();
    show = true;
    await rerender();
    await settle();
    expect(wire.gets.filter((path) => path.endsWith('/profile'))).toHaveLength(1);
    expect(wire.gets.filter((path) => path.endsWith('/features'))).toHaveLength(2);
  });

  it('reads the collections once: the realtime connection keeps them', async () => {
    await mount(() => useConversationCollections());
    show = false;
    await rerender();
    show = true;
    await rerender();
    await settle();
    expect(wire.gets).toEqual(['/v1/conversations/collections']);
  });
});

describe('what a read retries', () => {
  const status = (code: number) => ({ status: code });
  it('retries what another attempt can change, at most twice', () => {
    expect(retriesRead(1, new TypeError('Failed to fetch'))).toBe(true);
    expect(retriesRead(1, status(503))).toBe(true);
    expect(retriesRead(2, status(429))).toBe(true);
    expect(retriesRead(3, status(503))).toBe(false);
    expect(retriesRead(1, status(404))).toBe(false);
    expect(retriesRead(1, status(401))).toBe(false);
  });

  it('never retries a thread that is not there', () => {
    expect(retryThreadRead(1, status(404))).toBe(false);
    expect(retryThreadRead(1, status(500))).toBe(true);
    expect(retryThreadRead(3, status(500))).toBe(false);
  });
});
