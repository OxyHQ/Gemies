import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
const prefetchConversation = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/client', () => ({ default: { get } }));
vi.mock('@gemies/sdk/runtime', async () => {
  const data = await import('@/shared/testing/sdk-runtime-data');
  // The SDK's addressing, as its `routes.ts` states it: by handle, or `id:<gemieId>` by id.
  type Address = { handle: string } | { gemieId: string };
  const threadKey = (thread: Address) =>
    'handle' in thread ? thread.handle : `id:${thread.gemieId}`;
  const AGENT_ROUTES = {
    thread: (thread: Address) =>
      'handle' in thread ? `/agents/thread/${thread.handle}` : `/agents/${thread.gemieId}/thread`,
  };
  // The SDK's `gemieThread`: the thread's answer under its address, read through the SDK's client.
  const gemieThread = data.answerSource('test.thread', {
    key: (_api: unknown, thread: Address) => threadKey(thread),
    retry: 0,
    load: async (_request, api, thread) =>
      ((await (api as { get: typeof get }).get(AGENT_ROUTES.thread(thread))) as { data: unknown })
        .data,
  });
  return {
    ...data,
    AGENT_ROUTES,
    gemieThread,
    retryThreadRead: () => false,
    threadKey,
    useGemieApi: () => ({ get }),
    usePrefetchConversation: () => prefetchConversation,
  };
});

const { usePrefetchAgentThread } = await import('../use-agent-thread');
const { gemieThread } = await import('@gemies/sdk/runtime');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function mount() {
  const store = new Store();
  let prefetch!: ReturnType<typeof usePrefetchAgentThread>;
  function Probe() {
    prefetch = usePrefetchAgentThread();
    return null;
  }
  act(() => {
    renderer = create(
      <DataProvider store={store}>
        <Probe />
      </DataProvider>,
    );
  });
  const held = (key: string) =>
    withStore(store, () => gemieThread.entity.get(key))?.value as
      | { conversationId: string }
      | undefined;
  return { held, prefetch: (...args: Parameters<typeof prefetch>) => prefetch(...args) };
}

afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  get.mockReset();
  prefetchConversation.mockReset();
});

describe('reading an agent’s thread ahead of the press', () => {
  it('never asks for the thread of an agent the person has not talked to: asking CREATES it', async () => {
    const { prefetch } = mount();
    prefetch({ handle: 'pepe' }, false);
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the thread and then the conversation behind it, into the thread the screen reads', async () => {
    get.mockResolvedValue({ data: { agent: { _id: 'a1' }, conversationId: 'c9' } });
    const { held, prefetch } = mount();
    prefetch({ handle: 'pepe' }, true);
    await vi.waitFor(() => expect(prefetchConversation).toHaveBeenCalledWith('c9'));
    expect(get).toHaveBeenCalledExactlyOnceWith('/agents/thread/pepe');
    expect(held('pepe')).toMatchObject({ conversationId: 'c9' });
  });

  it('reads a gemie with no handle by its id, under the SDK’s key for that thread', async () => {
    get.mockResolvedValue({ data: { agent: { _id: 'g1' }, conversationId: 'c7' } });
    const { held, prefetch } = mount();
    prefetch({ gemieId: 'g1' }, true);
    await vi.waitFor(() => expect(prefetchConversation).toHaveBeenCalledWith('c7'));
    expect(get).toHaveBeenCalledExactlyOnceWith('/agents/g1/thread');
    expect(held('id:g1')).toMatchObject({ conversationId: 'c7' });
  });
});
