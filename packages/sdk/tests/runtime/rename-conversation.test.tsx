import { DataProvider, type Store } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Renaming a chat from the sidebar.
 *
 * The API has no title-only write: `POST /conversations` sets the title and
 * REPLACES the messages with what it is sent. The sidebar holds the row of a
 * conversation without its messages, so a rename that saved whatever the
 * record held would empty the thread. The contract is therefore:
 * read the thread fresh from the server, then save exactly those messages with
 * the new title.
 */

const http = vi.hoisted(() => ({
  requests: [] as string[],
  posted: [] as { conversationId: string; title?: string; messages: unknown[] }[],
  refuse: false,
}));

const SERVER_MESSAGES = [
  { id: 'u1', role: 'user', content: 'what is the capital of Peru' },
  { id: 'a1', role: 'assistant', content: 'Lima' },
];

vi.mock('../../src/runtime/api', () => {
  const stub = {
    get: vi.fn(async (path: string) => {
      http.requests.push(`GET ${path}`);
      return {
        data: {
          id: 'c1',
          title: 'Capitals',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-02T00:00:00Z',
          messages: SERVER_MESSAGES,
        },
      };
    }),
    post: vi.fn(
      async (
        path: string,
        body: { conversationId: string; title?: string; messages: unknown[] },
      ) => {
        http.requests.push(`POST ${path}`);
        http.posted.push(body);
        if (http.refuse) throw Object.assign(new Error('refused'), { status: 500 });
        return {
          data: {
            id: body.conversationId,
            title: body.title,
            createdAt: '2026-09-01T00:00:00Z',
            updatedAt: '2026-09-03T00:00:00Z',
          },
        };
      },
    ),
    delete: vi.fn(),
  };
  return { useGemieApi: () => stub };
});
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, canUsePrivateApi: true }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useRenameConversation } from '../../src/runtime/conversations';
import { freshStore, heldConversation, listIds, seedList } from '../support/data-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let api: ReturnType<typeof useRenameConversation>;
let store: Store;
let renderer: ReactTestRenderer | undefined;

function Probe() {
  api = useRenameConversation();
  return null;
}

async function mount() {
  store = freshStore();
  // What the sidebar holds: the list row, no messages.
  seedList(store, [
    {
      id: 'c0',
      title: 'Newer',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-05T00:00:00Z',
    },
    {
      id: 'c1',
      title: 'Capitals',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
    },
  ]);
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
  http.posted = [];
  http.refuse = false;
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('useRenameConversation', () => {
  it('reads the thread fresh, then saves its messages under the new title', async () => {
    await mount();
    await act(async () => {
      await api.run('c1', 'Peru');
    });

    expect(http.requests).toEqual(['GET /v1/conversations/c1', 'POST /v1/conversations']);
    expect(http.posted).toHaveLength(1);
    expect(http.posted[0].conversationId).toBe('c1');
    expect(http.posted[0].title).toBe('Peru');
    // Not the empty seed: the messages the server holds.
    expect(http.posted[0].messages).toHaveLength(SERVER_MESSAGES.length);
  });

  it('puts the new title in the sidebar list', async () => {
    await mount();
    await act(async () => {
      await api.run('c1', 'Peru');
    });
    expect(heldConversation(store, 'c1')).toMatchObject({ id: 'c1', title: 'Peru' });
    expect(listIds(store)[0]).toBe('c1');
  });

  it('shows the new title at once, and the old one again when the server refuses', async () => {
    http.refuse = true;
    vi.useFakeTimers();
    await mount();
    let done!: Promise<unknown>;
    act(() => {
      done = api.run('c1', 'Peru').catch((error: Error) => error);
    });
    expect(heldConversation(store, 'c1')?.title).toBe('Peru');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
    });
    vi.useRealTimers();
    expect(heldConversation(store, 'c1')?.title).toBe('Capitals');
    expect(listIds(store)).toEqual(['c0', 'c1']);
  });
});
