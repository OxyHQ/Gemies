import { DataProvider, Store } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A client too far behind the account's event log (a realtime reset) cannot trust what it holds:
 * a read on screen is read again at once, and every other one when it is next shown, however
 * fresh it still was.
 */

const gets = vi.hoisted(() => [] as string[]);
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, canUsePrivateApi: true }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../src/runtime/api', () => {
  const api = {
    get: async (path: string, request?: { params?: Record<string, unknown> }) => {
      gets.push(`${path}${request?.params?.agentId ? `?agentId=${request.params.agentId}` : ''}`);
      return { status: 200, data: { conversations: [], nextCursor: null, hasMore: false } };
    },
  };
  return { useGemieApi: () => api };
});

import type { RealtimeConnection } from '../../src/realtime/connection';
import { attachRealtimeStore } from '../../src/realtime/store';
import { useConversations } from '../../src/runtime/conversations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A connection whose reset the test fires. */
function fakeConnection() {
  const resets = new Set<() => void>();
  const connection = {
    on: () => () => undefined,
    onReset: (listener: () => void) => {
      resets.add(listener);
      return () => resets.delete(listener);
    },
  } as unknown as RealtimeConnection;
  return {
    connection,
    reset: () => {
      for (const listener of resets) listener();
    },
  };
}

function Own() {
  useConversations();
  return null;
}
function Pepe() {
  useConversations({ agentId: 'pepe' });
  return null;
}

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

describe('a realtime reset', () => {
  it('reads what is on screen again at once, and the rest when it is next shown', async () => {
    const store = new Store();
    const { connection, reset } = fakeConnection();
    const detach = attachRealtimeStore(connection, store);
    const tree = (pepe: boolean) => (
      <DataProvider store={store}>
        <Own />
        {pepe ? <Pepe /> : null}
      </DataProvider>
    );
    await act(async () => {
      renderer = create(tree(true));
    });
    await settle();
    // Pepe's list leaves the screen, still fresh (lists stay fresh five minutes).
    await act(async () => renderer?.update(tree(false)));
    expect(gets).toEqual(['/v1/conversations', '/v1/conversations?agentId=pepe']);

    reset();
    await settle();
    // On screen: read again at once. Off screen: not yet.
    expect(gets.slice(2)).toEqual(['/v1/conversations']);

    await act(async () => renderer?.update(tree(true)));
    await settle();
    // Shown again: read again although it was fresh, because the reset made it stale.
    expect(gets.slice(3)).toEqual(['/v1/conversations?agentId=pepe']);
    detach();
  });
});
