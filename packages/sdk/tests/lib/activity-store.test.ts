import { beforeEach, describe, expect, it } from 'vitest';
import { selectGemieActivity, useGemieActivityStore } from '../../src/lib/activity-store';
import { turnActivityState } from '../../src/lib/turn-state';
import type { Message } from '../../src/runtime/types';

const now = () => selectGemieActivity(useGemieActivityStore.getState());
const store = () => useGemieActivityStore.getState();

describe('activity store', () => {
  beforeEach(() => useGemieActivityStore.setState({ local: {} }));

  it('is idle with no source', () => {
    expect(now()).toBe('idle');
  });

  it('shows the busiest source: a tool call outranks thinking outranks writing', () => {
    store().setLocal('sheet', 'writing');
    expect(now()).toBe('writing');
    store().setLocal('s1', 'thinking');
    expect(now()).toBe('thinking');
    store().setLocal('s2', 'working');
    expect(now()).toBe('working');
    store().setLocal('s2', 'idle');
    expect(now()).toBe('thinking');
  });

  it('keeps no entry for an idle source, and leaves identical sets untouched', () => {
    store().setLocal('a', 'thinking');
    const before = store().local;
    store().setLocal('a', 'thinking');
    expect(store().local).toBe(before);
    store().setLocal('a', 'idle');
    expect(store().local).toEqual({});
    const empty = store().local;
    store().setLocal('a', 'idle');
    expect(store().local).toBe(empty);
  });
});

describe('turnActivityState', () => {
  const assistant = (extra: Partial<Message>): Message =>
    ({ id: 'a', role: 'assistant', content: '', createdAt: 0, ...extra }) as Message;

  it('reads a turn from its messages', () => {
    expect(turnActivityState([assistant({})], false)).toBe('idle');
    expect(turnActivityState([assistant({})], true)).toBe('writing');
    expect(turnActivityState([assistant({ thinking: 'hm' })], true)).toBe('thinking');
    expect(
      turnActivityState(
        [assistant({ toolInvocations: [{ toolCallId: '1', toolName: 't', state: 'call' }] })],
        true,
      ),
    ).toBe('working');
  });
});
