import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  loading: false,
  failed: false,
  setMessages: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../src/runtime/use-conversation-stream', () => ({
  useConversationStream: () => ({
    messages: [],
    append: vi.fn(),
    isLoading: world.loading,
    error: null,
    clearError: vi.fn(),
    setMessages: world.setMessages,
    stop: vi.fn(),
    detach: vi.fn(),
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: vi.fn(),
    failedTurn: world.failed ? { userMessageId: 'client-user', partial: false } : null,
    retryFailedTurn: vi.fn(),
    clearFailedTurn: vi.fn(),
    turnOptionsOf: vi.fn(),
  }),
}));
vi.mock('../../src/runtime/conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({ mutateAsync: vi.fn() }),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
  useClearConversation: () => ({ mutateAsync: vi.fn() }),
  useReadConversation: () => vi.fn(),
  useMarkConversationRead: () => vi.fn(),
}));
vi.mock('../../src/realtime/react', async (original) =>
  (await import('../support/fake-realtime')).mockRealtimeReact(await original()),
);

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ user: null, isAuthenticated: true }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: world.toast } }));
vi.mock('../../src/runtime/attachment-utils', () => ({ buildMessageContent: vi.fn() }));

import { DEFAULT_LABELS } from '../../src/lib/labels';
import { GemieRuntimeProvider } from '../../src/runtime/config';
import { fakeRealtime } from '../support/fake-realtime';
import { useConversationThread } from '../../src/runtime/use-conversation-thread';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
let queryClient: QueryClient;
function Probe() {
  useConversationThread({ conversationId: 'c1' });
  return null;
}
const tree = () => (
  <QueryClientProvider client={queryClient}>
    <GemieRuntimeProvider>
      <Probe />
    </GemieRuntimeProvider>
  </QueryClientProvider>
);
const fail = (chainId = 'db-user-message-id') =>
  act(async () => {
    fakeRealtime.push('room', {
      conversationId: 'c1',
      chainId,
      event: 'group.idle',
      data: { reason: 'error' },
    });
  });
beforeEach(() => {
  world.loading = false;
  world.failed = false;
  world.toast.mockClear();
  world.setMessages.mockClear();
  fakeRealtime.reset();
  queryClient = new QueryClient();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  queryClient.clear();
});

describe('late group failures in the thread', () => {
  it('uses the existing localized error notification without inventing a reply or a retry anchor', async () => {
    await act(async () => {
      renderer = create(tree());
    });
    await fail();
    expect(world.toast).toHaveBeenCalledExactlyOnceWith(DEFAULT_LABELS.sendFailed);
    await fail();
    expect(world.toast).toHaveBeenCalledTimes(1);
  });

  it.each(['loading', 'failed'] as const)(
    'lets HTTP or its failure card own the error while %s',
    async (state) => {
      world[state] = true;
      await act(async () => {
        renderer = create(tree());
      });
      await fail();
      expect(world.toast).not.toHaveBeenCalled();
      world[state] = false;
      await act(async () => renderer?.update(tree()));
      await fail();
      expect(world.toast).not.toHaveBeenCalled();
      await fail('a-later-chain');
      expect(world.toast).toHaveBeenCalledExactlyOnceWith(DEFAULT_LABELS.sendFailed);
    },
  );
});
