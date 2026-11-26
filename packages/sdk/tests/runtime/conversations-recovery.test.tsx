import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Missing and unreachable conversations, through the real REST layer over a fake Oxy client.
 *
 * A 404 on an authenticated read is authoritative: the offline copy of that conversation must go
 * (keeping it resurrects a deleted chat and every later read hits the same missing id again),
 * and the error is the stable `ConversationNotFoundError` a screen can leave on. A 401 is a
 * session that cannot reach the server: its offline copy is what the person sees, per account.
 */

const server = vi.hoisted(() => ({
  respond: (
    _method: string,
    _url: string,
  ): { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }> => ({
    status: 200,
  }),
  calls: [] as string[],
  apiReady: true,
}));

vi.mock('@oxy.so/services/ui/client', async () => ({
  ...(await import('../support/app-assertion-host')).hostWithoutAppAssertion,
  useOxy: () => ({
    isAuthenticated: true,
    canUsePrivateApi: server.apiReady,
    oxyServices: {
      createLinkedClient: () => ({
        client: {
          getSessionEpoch: () => 0,
          addTokenChangeListener: () => () => {},
          requestAuthenticatedResponse: async (config: { method: string; url: string }) => {
            server.calls.push(`${config.method} ${config.url}`);
            const { status, body } = await server.respond(config.method, config.url);
            return new Response(body === undefined ? null : JSON.stringify(body), { status });
          },
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { GemieRuntimeProvider, type OfflineConversationStore } from '../../src/runtime/config';
import { useConversation, useConversations } from '../../src/runtime/conversations';
import { ConversationNotFoundError, Conversations } from '../../src/runtime/data/conversations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const stored = { value: null as string | null };
const offline: OfflineConversationStore = {
  getItem: async () => stored.value,
  setItem: async (value) => {
    stored.value = value;
  },
};
const copy = (id: string) => ({
  id,
  title: `offline ${id}`,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  messages: [{ id: 'm1', role: 'user', content: 'kept offline' }],
});

let renderer: ReactTestRenderer | undefined;
let rerender: () => Promise<void>;
/** The store the tree reads: the signed-in account's. A switch opens another one. */
let store: Store;
function mount(probe: () => void) {
  function Probe() {
    probe();
    return null;
  }
  store = new Store();
  const tree = () => (
    <DataProvider store={store}>
      <GemieRuntimeProvider apiUrl="http://api.test" offline={offline}>
        <Probe />
      </GemieRuntimeProvider>
    </DataProvider>
  );
  rerender = async () => {
    await act(async () => {
      renderer?.update(tree());
    });
  };
  return act(async () => {
    renderer = create(tree());
  });
}

beforeEach(() => {
  server.calls = [];
  server.apiReady = true;
  stored.value = JSON.stringify([copy('c1'), copy('c2')]);
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('a conversation the server no longer has', () => {
  it('is a ConversationNotFoundError, and its offline copy is dropped with it', async () => {
    server.respond = () => ({ status: 404, body: { error: 'nope' } });
    let state: ReturnType<typeof useConversation> | undefined;
    await mount(() => {
      state = useConversation('c1');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.error).toBeInstanceOf(ConversationNotFoundError);
    expect(JSON.parse(stored.value ?? '[]').map((c: { id: string }) => c.id)).toEqual(['c2']);
  });
});

describe('a session the server cannot reach', () => {
  it('reads the conversation from its offline copy on a 401', async () => {
    server.respond = () => ({ status: 401, body: { error: 'expired' } });
    let state: ReturnType<typeof useConversation> | undefined;
    await mount(() => {
      state = useConversation('c1');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.value?.title).toBe('offline c1');
    expect(state?.value?.messages).toHaveLength(1);
    expect(state?.value?.createdAt).toBe('2026-09-01T00:00:00Z');
  });

  it('lists the offline copy a page at a time on a 401', async () => {
    server.respond = () => ({ status: 401 });
    let state: ReturnType<typeof useConversations> | undefined;
    await mount(() => {
      state = useConversations();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    // The list never carries messages.
    expect(state?.conversations[0]?.messages).toBeUndefined();
  });

  it('reports an authentication failure instead of caching an empty successful list', async () => {
    server.respond = () => ({ status: 401 });
    stored.value = null;
    let state: ReturnType<typeof useConversations> | undefined;
    await mount(() => {
      state = useConversations();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.conversations).toEqual([]);
    expect(state?.list).toBeUndefined();
    expect(state?.status).toBe('error');
  });
});

it('waits for usable authentication, then loads immediately', async () => {
  server.apiReady = false;
  server.respond = () => ({
    status: 200,
    body: {
      conversations: [{ ...copy('online'), messages: [] }],
      hasMore: false,
      nextCursor: null,
    },
  });
  let state: ReturnType<typeof useConversations> | undefined;
  await mount(() => {
    state = useConversations();
  });
  expect(server.calls).toEqual([]);
  server.apiReady = true;
  await rerender();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(server.calls).toHaveLength(1);
  expect(state?.conversations[0]?.id).toBe('online');
});

const page = (...ids: string[]) => ({
  status: 200,
  body: {
    conversations: ids.map((id) => ({ ...copy(id), messages: [] })),
    hasMore: false,
    nextCursor: null,
  },
});
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

/** Signs another account in: Services closes the account's store and opens the next one's. */
async function switchAccount() {
  const left = store;
  store = new Store();
  await left.close();
  await rerender();
}

describe('an account switch', () => {
  it("never shows the previous account's conversations", async () => {
    server.respond = () => page('a1', 'a2');
    const seen: string[][] = [];
    await mount(() => {
      seen.push(useConversations().conversations.map((c) => c.id));
    });
    await settle();
    expect(seen.at(-1)).toEqual(['a1', 'a2']);

    server.respond = () => page('b1');
    const before = seen.length;
    await switchAccount();
    await settle();
    expect(seen.at(-1)).toEqual(['b1']);
    expect(seen.slice(before).flat()).not.toContain('a1');
  });

  it('drops an answer that lands for the account that was left', async () => {
    let answerFirst!: () => void;
    server.respond = () =>
      new Promise((resolve) => {
        answerFirst = () => resolve(page('a1'));
      });
    let state: ReturnType<typeof useConversations> | undefined;
    await mount(() => {
      state = useConversations();
    });
    const left = store;
    server.respond = () => page('b1');
    await switchAccount();
    await settle();
    answerFirst();
    await settle();
    expect(state?.conversations.map((c) => c.id)).toEqual(['b1']);
    expect(withStore(left, () => Conversations.get('a1'))).toBeUndefined();
  });
});

describe('the rules a read keeps', () => {
  it('does not read a fresh list again when a screen opens it again', async () => {
    server.respond = () => page('a1');
    let show = true;
    function Toggle() {
      return show ? <Probe /> : null;
    }
    function Probe() {
      useConversations();
      return null;
    }
    store = new Store();
    const tree = () => (
      <DataProvider store={store}>
        <GemieRuntimeProvider apiUrl="http://api.test" offline={offline}>
          <Toggle />
        </GemieRuntimeProvider>
      </DataProvider>
    );
    await act(async () => {
      renderer = create(tree());
    });
    await settle();
    show = false;
    await act(async () => renderer?.update(tree()));
    show = true;
    await act(async () => renderer?.update(tree()));
    await settle();
    expect(server.calls.filter((call) => call.startsWith('GET /v1/conversations'))).toHaveLength(1);
  });

  it('reads the conversation once and never retries a missing one', async () => {
    server.respond = () => ({ status: 404 });
    await mount(() => {
      useConversation('gone');
    });
    await settle();
    expect(server.calls).toEqual(['GET /v1/conversations/gone']);
  });
});
