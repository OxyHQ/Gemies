import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ feeds: [] as string[] }));

vi.mock('../../src/realtime/react', () => ({
  useRealtimeActivityFeed: (apiUrl: string) => {
    mocks.feeds.push(apiUrl);
  },
}));

import { useGemieActivity } from '../../src/hooks/useGemieActivity';
import { useGemieActivityStore } from '../../src/lib/activity-store';
import { useRealtimeActivityStore } from '../../src/realtime/activity';

let seen: string[] = [];
function Probe() {
  seen.push(useGemieActivity({ apiUrl: 'https://api.test' }));
  return null;
}

describe('useGemieActivity', () => {
  beforeEach(() => {
    seen = [];
    mocks.feeds.length = 0;
    useGemieActivityStore.setState({ local: {} });
    useRealtimeActivityStore.getState().clear();
  });

  it('hears the account through the realtime feed of the API it names', () => {
    act(() => {
      TestRenderer.create(<Probe />);
    });
    expect(mocks.feeds[0]).toBe('https://api.test');
  });

  it('shows the busiest of this app’s turns and the gemies working elsewhere', () => {
    act(() => {
      TestRenderer.create(<Probe />);
    });
    expect(seen.at(-1)).toBe('idle');
    act(() => useGemieActivityStore.getState().setLocal('sheet', 'writing'));
    expect(seen.at(-1)).toBe('writing');
    act(() =>
      useRealtimeActivityStore.getState().apply({
        conversationId: null,
        sessionId: 's',
        actor: { agentId: null },
        state: 'tool',
        ttlMs: 30_000,
      }),
    );
    // A tool in use is the avatar's `working`.
    expect(seen.at(-1)).toBe('working');
    act(() =>
      useRealtimeActivityStore.getState().apply({
        conversationId: null,
        sessionId: 's',
        actor: { agentId: null },
        state: 'idle',
        ttlMs: 30_000,
      }),
    );
    expect(seen.at(-1)).toBe('writing');
  });
});
