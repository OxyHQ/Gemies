import { DataProvider, type Persister, Store, withStore } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The person's agents and spaces are the account's data (docs/instant-loading.md): a returning
 * person's sidebar draws them from what the account's store copied to disk, before the server
 * answers; another account never sees them; and they are on disk under `PERSISTED_DATA_VERSION`, so
 * a change of shape drops them rather than drawing an old row in a new shape.
 */

const session = vi.hoisted(() => ({ ready: true }));
const wire = vi.hoisted(() => ({
  gets: [] as string[],
  /** What a GET answers; a promise that never settles holds the read open. */
  answer: (_path: string): Promise<unknown> => new Promise(() => undefined),
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ user: { id: 'A' }, canUsePrivateApi: session.ready }),
}));
vi.mock('@/shared/api/client', () => ({
  default: {
    get: async (path: string) => {
      wire.gets.push(path);
      return { data: await wire.answer(path) };
    },
    post: async () => ({ status: 204 }),
  },
}));
vi.mock('@gemies/sdk/runtime', async () => ({
  ...(await import('@/shared/testing/sdk-runtime-data')),
  useConversationsClient: () => ({}),
  refreshConversationLists: () => undefined,
}));

const { myAgents, spaces } = await import('@/shared/api/account-data');
const { PERSISTED_DATA_VERSION } = await import('@/shared/api/persisted-data-version');
const { useMyAgents } = await import('@/features/agents/runtime/use-my-agents');
const { useSpaces } = await import('@/features/spaces/runtime/use-spaces');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** One account's durable copy, kept across the stores opened on it (a restart). */
function diskCopy() {
  const rows = new Map<string, string>();
  const opened: Parameters<Persister['open']>[0][] = [];
  const persister: Persister = {
    open: async (options) => {
      opened.push(options);
    },
    readRecords: async (type, ids) =>
      ids.flatMap((id) => {
        const json = rows.get(`${type}/${id}`);
        return json === undefined ? [] : [{ id, json }];
      }),
    readList: async () => null,
    write: async (batch) => {
      for (const record of batch.records) {
        if (record.json === null) rows.delete(`${record.type}/${record.id}`);
        else rows.set(`${record.type}/${record.id}`, record.json);
      }
    },
    close: async () => undefined,
    destroy: async () => rows.clear(),
  };
  return { persister, opened, rows };
}

let renderer: ReactTestRenderer | undefined;
const seen: { agents?: unknown; spaces?: unknown } = {};
function Sidebar() {
  seen.agents = useMyAgents().value;
  seen.spaces = useSpaces().value;
  return null;
}
async function open(store: Store) {
  const client = new QueryClient();
  await act(async () => {
    const tree = (
      <DataProvider store={store}>
        <QueryClientProvider client={client}>
          <Sidebar />
        </QueryClientProvider>
      </DataProvider>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const pepe = { _id: 'a1', name: 'Pepe' };
const team = { id: 's1', name: 'Equipo', memberAgentIds: ['a1'] };

beforeEach(() => {
  session.ready = true;
  wire.gets = [];
  wire.answer = () => new Promise(() => undefined);
  seen.agents = undefined;
  seen.spaces = undefined;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('the sidebar of a returning person', () => {
  it('is drawn from what the account saw last, while it is read again behind it', async () => {
    const disk = diskCopy();
    // Yesterday: the server answered, and the account's store copied it to disk.
    const yesterday = new Store({ persister: disk.persister });
    withStore(yesterday, () => {
      myAgents.entity.put({ id: 'account', value: [pepe] as never });
      spaces.entity.put({ id: 'account', value: [team] as never });
    });
    await yesterday.flush();
    await yesterday.close();

    // Today: the server has not answered (and will not, in this test).
    await open(new Store({ persister: disk.persister }));

    expect(seen.agents).toEqual([pepe]);
    expect(seen.spaces).toEqual([team]);
    expect(wire.gets).toEqual(expect.arrayContaining(['/agents/me', '/spaces']));
  });

  it('keeps both on disk under the shape version, so a new shape drops them', async () => {
    const disk = diskCopy();
    const store = new Store({ persister: disk.persister });
    withStore(store, () => myAgents.entity.put({ id: 'account', value: [pepe] as never }));
    await store.flush();
    const versions = disk.opened.at(-1)?.versions ?? {};
    expect(versions['alia.my-agents']).toBe(PERSISTED_DATA_VERSION);
    expect(versions['alia.spaces']).toBe(PERSISTED_DATA_VERSION);
    await store.close();
  });

  it('never shows another account’s: each account reads its own store', async () => {
    const a = new Store();
    withStore(a, () => myAgents.entity.put({ id: 'account', value: [pepe] as never }));
    await open(a);
    expect(seen.agents).toEqual([pepe]);

    // Services closes the account's store and opens the next account's.
    const b = new Store();
    await a.close();
    await open(b);
    expect(seen.agents).toBeUndefined();
  });

  it('asks for nothing until the private API is usable', async () => {
    session.ready = false;
    await open(new Store());
    expect(wire.gets).toEqual([]);
  });
});
