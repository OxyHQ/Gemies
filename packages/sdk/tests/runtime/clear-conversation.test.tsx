import { DataProvider, type Store } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `useClearConversation` does to the account's store, and WHEN (#553).
 *
 * The held history is the reason "Clear conversation" used to undo itself:
 * the thread resets its screen and then, seeing a record with messages and a
 * screen with none, hydrates the record back in. So the action's contract is
 * precise about the record:
 *
 * - on SUCCESS its messages are emptied and its preview dropped, it keeps its
 *   place in the list, and the conversation and the list are read again so
 *   the server's answer replaces the local guess;
 * - while it is in flight the messages are already gone (its layer), and on
 *   FAILURE the layer goes: the record is exactly as it was, because the
 *   dialog that asked for the clear promised the opposite of "it will be back".
 *
 * The API client is mocked at the module boundary; the request it must make
 * is pinned by path and method, since a clear that hit `DELETE
 * /conversations/:id` instead would remove the thread rather than empty it.
 */

const http = vi.hoisted(() => ({
  /** Every request the hook made, as `METHOD path`. */
  requests: [] as string[],
  outcome: 'ok' as 'ok' | { status: number },
  /** A clear waits on this when set. */
  hold: null as Promise<void> | null,
}));

vi.mock('../../src/runtime/api', () => {
  const stub = {
    delete: vi.fn(async (path: string) => {
      http.requests.push(`DELETE ${path}`);
      if (http.hold) await http.hold;
      if (http.outcome !== 'ok') {
        throw Object.assign(new Error(`Request failed with status code ${http.outcome.status}`), {
          isAxiosError: true,
          response: { status: http.outcome.status, data: { error: 'nope' } },
        });
      }
      return { data: { success: true } };
    }),
    get: vi.fn(async (path: string) => {
      http.requests.push(`GET ${path}`);
      return path === '/v1/conversations'
        ? {
            data: {
              conversations: [
                { id: 'c1', title: 'Capitals', createdAt: '', updatedAt: '' },
                {
                  id: 'c2',
                  title: 'Unrelated',
                  lastMessage: 'still here',
                  createdAt: '',
                  updatedAt: '',
                },
              ],
              nextCursor: null,
              hasMore: false,
            },
          }
        : { data: { id: 'c1', title: 'Capitals', createdAt: '', updatedAt: '', messages: [] } };
    }),
    post: vi.fn(),
  };
  return { useGemieApi: () => stub };
});
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, canUsePrivateApi: true }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useClearConversation } from '../../src/runtime/conversations';
import type { Conversation } from '../../src/runtime/types';
import { freshStore, heldConversation, listIds, seedList } from '../support/data-store';

let api: ReturnType<typeof useClearConversation>;
let store: Store;
let renderer: ReactTestRenderer | undefined;

function Probe() {
  api = useClearConversation();
  return null;
}

const THREAD: Conversation = {
  id: 'c1',
  title: 'Capitals',
  lastMessage: 'Lima',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  messages: [
    { id: 'u1', role: 'user', content: 'what is the capital of Peru' },
    { id: 'a1', role: 'assistant', content: 'Lima' },
  ],
};

const OTHER: Conversation = {
  id: 'c2',
  title: 'Unrelated',
  lastMessage: 'still here',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

async function mount() {
  store = freshStore();
  // The state the screen is in when the dialog is confirmed.
  seedList(store, [THREAD, OTHER]);
  await act(async () => {
    renderer = create(
      <DataProvider store={store}>
        <Probe />
      </DataProvider>,
    );
  });
}

beforeEach(() => {
  http.requests = [];
  http.outcome = 'ok';
  http.hold = null;
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useClearConversation', () => {
  it('sends one DELETE to the messages sub-resource, never to the conversation itself', async () => {
    await mount();

    await act(async () => {
      await api.run('c1');
    });

    expect(http.requests.filter((r) => r.startsWith('DELETE'))).toEqual([
      'DELETE /v1/conversations/c1/messages',
    ]);
  });

  it('empties the held thread and drops its preview on success, keeping the row', async () => {
    await mount();
    let release!: () => void;
    http.hold = new Promise((resolve) => {
      release = resolve;
    });
    let done!: Promise<unknown>;
    act(() => {
      done = api.run('c1');
    });
    // Its layer: the messages are gone at once.
    expect(heldConversation(store, 'c1')?.messages).toEqual([]);
    await act(async () => {
      release();
      await done;
    });

    const held = heldConversation(store, 'c1');
    // Empty, not gone: the title and the row survive; only what the server
    // deleted is dropped locally.
    expect(held).toMatchObject({ id: 'c1', title: 'Capitals', messages: [] });
    expect(held?.lastMessage).toBeUndefined();
    expect(listIds(store)).toContain('c2');
    // A neighbour is not a casualty of somebody else's clear.
    expect(heldConversation(store, 'c2')?.lastMessage).toBe('still here');
  });

  it('reads the thread and the list again once the server emptied it', async () => {
    await mount();

    await act(async () => {
      await api.run('c1');
    });

    expect(http.requests).toContain('GET /v1/conversations/c1');
    expect(http.requests).toContain('GET /v1/conversations');
  });

  it('puts the thread back exactly as it was when the server refuses', async () => {
    http.outcome = { status: 500 };
    vi.useFakeTimers();
    await mount();

    // A write retries once, a second later; the clock is advanced past it rather than waited on.
    const attempt = api.run('c1').catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const settled = await attempt;

    expect(settled).toBeInstanceOf(Error);
    // Tried, retried, and refused both times, and the record is exactly as it
    // was seeded: a cleared thread under a failed clear is the bug's mirror.
    expect(http.requests).toEqual([
      'DELETE /v1/conversations/c1/messages',
      'DELETE /v1/conversations/c1/messages',
    ]);
    expect(heldConversation(store, 'c1')).toEqual(THREAD);
    expect(listIds(store)).toEqual(['c1', 'c2']);
  });
});
