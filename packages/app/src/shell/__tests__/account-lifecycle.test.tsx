import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #608 §4: signing out or switching accounts leaves nothing of the previous
 * account on screen, and a read still in flight for it cannot put it back.
 */

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
    removeItem: async (key: string) => void storage.delete(key),
  },
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({}),
  // The SDK reads the host's app assertion from here (ADR 0021); this host has none.
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
}));
vi.mock('@/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useConversationStore, useThoughtStore } from '@gemies/sdk/runtime';
import { useStore } from '@/features/chat/runtime/global-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useLibraryStore } from '@/features/library/runtime/library-store';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { offlineConversations } from '@/features/chat/runtime/offline-conversations';
import { currentAccountEpoch, isCurrentAccountEpoch } from '@/shared/state/account-epoch';
import { resetAccountSession, useAccountLifecycle } from '@/shell/account-lifecycle';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const message = { id: 'm1', role: 'user' as const, content: 'account A’s secret' };

function seedAccountA(client: QueryClient) {
  useUIStore.setState({
    rightPanelWidth: 480,
    rightPanel: 'thought',
    canvasArtifacts: [{ id: 'a1' } as never],
  });
  useThoughtStore.getState().open('m1', {
    conversationId: 'c1',
    messages: [message],
    status: 'ready',
    isLoading: false,
    failedTurn: null,
  });
  useConversationStore.setState({
    pendingInitialMessage: {
      conversationId: 'c1',
      content: 'hi',
      text: 'hi',
      attachments: [],
      mcpServerId: null,
      skillNames: [],
    },
  });
  useStore.setState({ ghostMode: true });
  useUserDataStore.setState({
    memory: { settings: { recallEnabled: false }, preferences: { voice: 'male' } },
  });
  useLibraryStore.setState({ files: [{ _id: 'f1' } as never] });
  client.setQueryData(['credits'], { balance: 10 });
  client.setQueryData(['agents', 'detail', 'a1'], { _id: 'a1' });
}

function expectNothingOfA() {
  const ui = useUIStore.getState();
  expect(ui.rightPanel).toBeNull();
  expect(useThoughtStore.getState().selection).toBeNull();
  expect(ui.canvasArtifacts).toEqual([]);
  expect(useConversationStore.getState().pendingInitialMessage).toBeNull();
  expect(useStore.getState().ghostMode).toBe(false);
  expect(useUserDataStore.getState().memory).toBeNull();
  expect(useLibraryStore.getState().files).toEqual([]);
}

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  storage.clear();
});

describe('resetAccountSession', () => {
  it('empties every store that held the previous account, and keeps the device’s layout', () => {
    seedAccountA(client);
    resetAccountSession(client);
    expectNothingOfA();
    // The device's, not the account's.
    expect(useUIStore.getState().rightPanelWidth).toBe(480);
  });

  it('drops every query: all of them are the app’s own, and memory only', async () => {
    seedAccountA(client);
    resetAccountSession(client);
    await vi.waitFor(() => expect(client.getQueryData(['credits'])).toBeUndefined());
    expect(client.getQueryData(['agents', 'detail', 'a1'])).toBeUndefined();
  });

  it('forgets a write still waiting for the network instead of replaying it as the next account', async () => {
    const sent = vi.fn(async () => undefined);
    onlineManager.setOnline(false);
    try {
      const write = client
        .getMutationCache()
        .build(client, { mutationKey: ['email-alerts-update'], mutationFn: sent });
      void write.execute(undefined).catch(() => undefined);
      await vi.waitFor(() => expect(write.state.isPaused).toBe(true));
      resetAccountSession(client);
      expect(client.getMutationCache().getAll()).toEqual([]);
    } finally {
      onlineManager.setOnline(true);
    }
    await client.resumePausedMutations();
    expect(sent).not.toHaveBeenCalled();
  });

  it('retires the epoch a read in flight for the previous account took', () => {
    const taken = currentAccountEpoch();
    resetAccountSession(client);
    expect(isCurrentAccountEpoch(taken)).toBe(false);
  });
});

describe('useAccountLifecycle', () => {
  let renderer: ReactTestRenderer | null = null;
  function Probe({ userId }: { userId: string | null }) {
    useAccountLifecycle(userId);
    return null;
  }
  const render = (userId: string | null) =>
    act(async () => {
      const tree = (
        <QueryClientProvider client={client}>
          <Probe userId={userId} />
        </QueryClientProvider>
      );
      if (renderer) renderer.update(tree);
      else renderer = create(tree);
    });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
  });

  it('clears on a sign-out', async () => {
    await render('A');
    seedAccountA(client);
    await render(null);
    expectNothingOfA();
  });

  it('keeps what was there on a first sign-in from signed out', async () => {
    await render(null);
    useStore.setState({ ghostMode: true });
    await render('A');
    expect(useStore.getState().ghostMode).toBe(true);
  });
});

describe('the offline copy of the conversations', () => {
  it('belongs to one account', async () => {
    offlineConversations.bind('A');
    await offlineConversations.setItem(JSON.stringify([{ id: 'c1', title: 'A’s chat' }]));
    offlineConversations.bind('B');
    expect(await offlineConversations.getItem()).toBeNull();
    offlineConversations.bind(null);
    expect(await offlineConversations.getItem()).toBeNull();
  });
});
