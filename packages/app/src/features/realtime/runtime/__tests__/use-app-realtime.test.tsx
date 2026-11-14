/**
 * The app's lists follow the account's realtime events with no reload: a gemie that changed is
 * read again, and so is its own Telegram bot, whose link to the person finishes in Telegram.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (frame: { data: unknown }) => void>());
vi.mock('@gemies/sdk/runtime', () => ({
  useGemieRealtime: () => ({ onStatus: () => () => undefined }),
  useRealtimeReset: () => undefined,
  useRealtimeEvent: (name: string, handler: (frame: { data: unknown }) => void) => {
    handlers.set(name, handler);
  },
}));
vi.mock('@/features/chat/runtime/use-agent-row-preview', () => ({ patchAgentRow: vi.fn() }));

import { queryKeys } from '@/shared/api/query-keys';
import { useAppRealtime } from '../use-app-realtime';

function Probe() {
  useAppRealtime();
  return null;
}

describe('the app’s realtime lists', () => {
  it('reads a gemie’s Telegram bot again when that gemie changed, so its link shows at once', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await act(async () => {
      create(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    act(() => handlers.get('gemies')?.({ data: { agentId: 'gemie-1', change: 'updated' } }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.agents.telegramBot('gemie-1') });
  });
});
