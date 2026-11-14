import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What "Clear conversation" does once the dialog says yes (#553).
 *
 * The header confirmed under "This action cannot be undone" and then reset
 * the local message list and nothing else — the cached history hydrated
 * straight back on the next render. The fix is an ORDER: the server clear
 * runs first, and only once it has succeeded is the screen reset. Every case
 * below is about that order, or about what happens when it cannot complete:
 *
 * - the request goes out exactly once, and the screen empties AFTER it
 *   resolves, not before;
 * - a refusal leaves the screen as it was and surfaces the error — the state
 *   this hook must never produce is a cleared view whose history is about to
 *   return;
 * - a turn still streaming is stopped, and has ENDED, before the request, so
 *   the thread being emptied is one nothing is writing into — a turn still
 *   finishing on the server would store itself back into it — and a turn that
 *   cannot be stopped is a refusal.
 *
 * `useClearConversation` is mocked: what it does to the query cache on success
 * is its own contract, pinned in `use-clear-conversation.test.tsx`.
 */

const chat = vi.hoisted(() => ({
  messages: [] as { id: string; role: string; content: unknown }[],
  isLoading: false,
  /** Every observable side effect, in the order it happened. The order IS the assertion. */
  sequence: [] as string[],
  /** What the mocked server clear does: resolve, or refuse. */
  clearOutcome: 'ok' as 'ok' | Error,
  /** Whether the mocked Stop ends the turn (`true`) or the server refuses to stop it. */
  stopOutcome: true,
}));

vi.mock('../../src/runtime/use-conversation-stream', () => ({
  useConversationStream: () => ({
    messages: chat.messages,
    append: vi.fn(async () => 'sent'),
    isLoading: chat.isLoading,
    error: null,
    clearError: vi.fn(),
    setMessages: vi.fn((next: unknown) => {
      const resolved =
        typeof next === 'function' ? (next as (p: unknown) => unknown)(chat.messages) : next;
      chat.sequence.push(`setMessages:${JSON.stringify(resolved)}`);
    }),
    // Stop settles only once the turn has ended; a macrotask later, so a clear that did not wait
    // for it would show up in the sequence before `stopped`.
    stop: vi.fn(async () => {
      chat.sequence.push('stop');
      await new Promise((resolve) => setTimeout(resolve, 0));
      chat.sequence.push(chat.stopOutcome ? 'stopped' : 'stop refused');
      return chat.stopOutcome;
    }),
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: vi.fn(),
    failedTurn: null,
    retryFailedTurn: vi.fn(),
    clearFailedTurn: vi.fn(() => {
      chat.sequence.push('clearFailedTurn');
    }),
  }),
}));

vi.mock('../../src/runtime/conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({ mutateAsync: vi.fn() }),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
  useReadConversation: () => async () => ({ messages: [] }),
  useMarkConversationRead: () => () => undefined,
  useClearConversation: () => ({
    mutateAsync: vi.fn(async (id: string) => {
      chat.sequence.push(`clear:${id}`);
      if (chat.clearOutcome !== 'ok') throw chat.clearOutcome;
      return id;
    }),
  }),
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: null,
    isAuthenticated: true,
    canUsePrivateApi: true,
    isAccountCacheReady: true,
  }),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
// Platform modules the hook imports for its SEND path. None takes part in a
// clear; they are here because importing them pulls React Native's Flow
// source into the runner.
vi.mock('../../src/runtime/attachment-utils', () => ({
  buildMessageContent: (text: string) => text,
}));

import { DEFAULT_LABELS } from '../../src/lib/labels';
import { useConversationThread } from '../../src/runtime/use-conversation-thread';

let api: ReturnType<typeof useConversationThread>;

function Probe({ conversationId }: { conversationId?: string }) {
  api = useConversationThread({ conversationId });
  return null;
}

/** `null` mounts a screen with no conversation id — `undefined` would take the default. */
async function mount(conversationId: string | null = 'c1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    create(
      <QueryClientProvider client={client}>
        <Probe conversationId={conversationId ?? undefined} />
      </QueryClientProvider>,
    );
  });
  // Mounting syncs the (empty) detail query into the screen, which is one
  // `setMessages` of its own; only what the clear does afterwards is measured.
  chat.sequence = [];
}

const HISTORY = [
  { id: 'u1', role: 'user', content: 'what is the capital of Peru' },
  { id: 'a1', role: 'assistant', content: 'Lima' },
];

beforeEach(() => {
  chat.messages = HISTORY;
  chat.isLoading = false;
  chat.sequence = [];
  chat.clearOutcome = 'ok';
  chat.stopOutcome = true;
  toast.error.mockClear();
});

describe('clearConversation', () => {
  it('clears on the server exactly once, and only then empties the screen', async () => {
    await mount();

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await api.clearConversation();
    });

    expect(outcome).toBe(true);
    // The request first; the local reset only after it resolved. The reverse
    // order is the bug: a screen emptied while the cache still held the
    // history, which the sync effect then restored.
    expect(chat.sequence).toEqual(['clear:c1', 'setMessages:[]', 'clearFailedTurn']);
    expect(chat.sequence.filter((step) => step.startsWith('clear:'))).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the history and surfaces the error when the server refuses', async () => {
    chat.clearOutcome = new Error('500 from the API');
    await mount();

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await api.clearConversation();
    });

    expect(outcome).toBe(false);
    // Nothing local moved: no reset, no failed-turn clear. The one state this
    // must never produce is an empty view whose history is about to return.
    expect(chat.sequence).toEqual(['clear:c1']);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(DEFAULT_LABELS.conversationClearFailed);
  });

  it('stops a turn still streaming, and waits for it to END, BEFORE it clears', async () => {
    chat.isLoading = true;
    await mount();

    await act(async () => {
      await api.clearConversation();
    });

    // The turn is over first, so the thread being emptied is one nothing is
    // still writing into — a turn the server was still finishing would have
    // stored its question and answer back after the clear; then the same
    // order as an idle clear.
    expect(chat.sequence).toEqual([
      'stop',
      'stopped',
      'clear:c1',
      'setMessages:[]',
      'clearFailedTurn',
    ]);
  });

  it('keeps everything when the running turn could not be stopped', async () => {
    chat.isLoading = true;
    chat.stopOutcome = false;
    await mount();

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await api.clearConversation();
    });

    // A clear beside a turn that is still running would be undone by it.
    expect(outcome).toBe(false);
    expect(chat.sequence).toEqual(['stop', 'stop refused']);
    expect(toast.error).toHaveBeenCalledWith(DEFAULT_LABELS.conversationClearFailed);
  });

  it('does not stop anything when nothing is streaming', async () => {
    await mount();

    await act(async () => {
      await api.clearConversation();
    });

    expect(chat.sequence).not.toContain('stop');
  });

  it('resets locally with no request when there is no conversation to clear', async () => {
    await mount(null);

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await api.clearConversation();
    });

    // Nothing is persisted for a thread without an id, so the screen's own
    // list is all there is to empty.
    expect(outcome).toBe(true);
    expect(chat.sequence).toEqual(['setMessages:[]', 'clearFailedTurn']);
  });
});
