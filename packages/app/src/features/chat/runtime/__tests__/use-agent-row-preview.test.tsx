import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('@gemies/sdk/runtime', () => import('@/shared/testing/sdk-runtime-data'));

import { useAgentRowPreview } from '../use-agent-row-preview';
import { myAgents } from '@/shared/api/account-data';
import type { Agent } from '@/shared/contracts/agents';
import { ACCOUNT } from '@gemies/sdk/runtime';

/**
 * The sidebar's agent row, while you are talking to that agent.
 *
 * Two properties, and the second is the one that makes this worth writing. The
 * row has to change the instant a line exists — and it must NOT change once per
 * token, which is what a naive "keep it fresh" fix does and what would repaint
 * the whole sidebar twenty times a second behind a streaming answer.
 *
 * Cost is asserted rather than assumed: the number of writes is counted against
 * a stream of many tokens, so the per-token version fails on the count even
 * though the final text it lands on is identical.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    _id: 'a1',
    name: 'Pepe',
    lastMessage: 'something older',
    lastMessageAt: '2026-08-01T10:00:00.000Z',
    // Both halves of the order the server sends: an agent with no thread falls
    // back to this, so a fixture without it could not tell the two apart.
    createdAt: '2026-07-01T10:00:00.000Z',
    ...over,
  }) as Agent;

function mount(seed?: Agent[]) {
  // The person's agents live in the account's store (`myAgents`), which the sidebar draws.
  const store = new Store();
  if (seed !== undefined) withStore(store, () => myAgents.entity.put({ id: ACCOUNT, value: seed }));
  const fetched = vi.spyOn(myAgents, 'invalidateAll');
  let preview: ReturnType<typeof useAgentRowPreview> | undefined;
  function Probe() {
    preview = useAgentRowPreview();
    return null;
  }
  act(() => {
    renderer = create(
      <DataProvider store={store}>
        <Probe />
      </DataProvider>,
    );
  });
  if (preview === undefined) throw new Error('the preview hook did not run');

  return {
    preview,
    rows: () => withStore(store, () => myAgents.entity.get(ACCOUNT))?.value,
    /** Counts every time the held list is rewritten. */
    countWrites: () => {
      const writes = vi.spyOn(myAgents.entity, 'update');
      return {
        stop: () => {
          const count = writes.mock.calls.length;
          writes.mockRestore();
          return count;
        },
      };
    },
    fetched,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the agent row preview', () => {
  it('shows the line straight away, without asking the server', () => {
    const { preview, rows, fetched } = mount([agent()]);

    act(() => preview('a1', 'what I just sent'));

    expect(rows()?.[0]?.lastMessage).toBe('what I just sent');
    // A write, not a refetch: invalidating would fetch the whole list back to
    // be told a thing the client just said.
    expect(fetched).not.toHaveBeenCalled();
  });

  it('replaces it with the answer when the turn is done', () => {
    const { preview, rows } = mount([agent()]);

    act(() => preview('a1', 'what I just sent'));
    act(() => preview('a1', 'what the agent answered'));

    expect(rows()?.[0]?.lastMessage).toBe('what the agent answered');
  });

  it('writes ONCE per line, not once per token', () => {
    // The control that rules out the naive fix. A per-token version lands on the
    // same final text, so only the count can tell them apart.
    const { preview, countWrites } = mount([agent()]);
    const counter = countWrites();

    const answer = 'a fairly long answer arriving in many small pieces';
    act(() => preview('a1', 'what I just sent'));
    act(() => preview('a1', answer));

    // Two lines said, two writes — whatever the answer's length.
    expect(counter.stop()).toBe(2);
    expect(answer.split(' ').length).toBeGreaterThan(5);
  });

  it('touches only the agent being spoken to', () => {
    const untouched = agent({ _id: 'a2', name: 'Other', lastMessage: 'leave me alone' });
    const { preview, rows } = mount([agent(), untouched]);
    const before = rows()?.[1];

    act(() => preview('a1', 'what I just sent'));

    expect(rows()?.[1]?.lastMessage).toBe('leave me alone');
    // The same object, so a row nobody spoke to is not re-rendered for having
    // been rebuilt.
    expect(rows()?.[1]).toBe(before);
  });

  it('moves the row you spoke to up, and leaves every other one where it was', () => {
    // The list as the server sends it: newest thread first. Talking to the one
    // at the bottom has to lift it to the top, because that is where the next
    // real load will put it.
    const { preview, rows } = mount([
      agent({ _id: 'a1', lastMessageAt: '2026-08-03T10:00:00.000Z' }),
      agent({ _id: 'a2', lastMessageAt: '2026-08-02T10:00:00.000Z' }),
      agent({ _id: 'a3', lastMessageAt: '2026-08-01T10:00:00.000Z' }),
    ]);

    act(() => preview('a3', 'the conversation I am having now'));

    expect(rows()?.map((row) => row._id)).toEqual(['a3', 'a1', 'a2']);
  });

  it('sorts an agent with no thread yet BELOW the ones that have one', () => {
    // The asymmetry this shares with the SQL. `lastMessageAt` is null on an
    // agent created a moment ago; a comparator that treated the absence as a
    // value would float it to the top, and Postgres does exactly that in a
    // `DESC` order unless `NULLS LAST` says otherwise.
    // Seeded with the thread-less one FIRST, so the assertion is only satisfied
    // by actually moving it down — an order that was already right proves
    // nothing about the comparator.
    const { preview, rows } = mount([
      agent({ _id: 'never', lastMessage: null, lastMessageAt: null }),
      agent({ _id: 'spoken', lastMessageAt: '2026-08-01T10:00:00.000Z' }),
    ]);

    act(() => preview('spoken', 'still the only thread there is'));

    expect(rows()?.map((row) => row._id)).toEqual(['spoken', 'never']);
  });

  it('orders agents nobody has spoken to by when they were made', () => {
    // The whole list on the fallback, which is what a new account sees. Talking
    // to the older one is what puts it above the newer one — nothing else can.
    const { preview, rows } = mount([
      agent({ _id: 'newer', lastMessageAt: null, createdAt: '2026-07-02T10:00:00.000Z' }),
      agent({ _id: 'older', lastMessageAt: null, createdAt: '2026-07-01T10:00:00.000Z' }),
    ]);
    expect(rows()?.map((row) => row._id)).toEqual(['newer', 'older']);

    act(() => preview('older', 'the first thing ever said to it'));

    expect(rows()?.map((row) => row._id)).toEqual(['older', 'newer']);
  });

  it('stamps when it happened, so the row does not read as stale', () => {
    const { preview, rows } = mount([agent()]);

    act(() => preview('a1', 'what I just sent'));

    const stamped = rows()?.[0]?.lastMessageAt;
    expect(stamped).not.toBe('2026-08-01T10:00:00.000Z');
    expect(Date.now() - new Date(stamped ?? 0).getTime()).toBeLessThan(5000);
  });

  it('says nothing for the main chat, which has no agent', () => {
    const { preview, rows } = mount([agent()]);

    act(() => preview(undefined, 'a message with no agent behind it'));
    act(() => preview(null, 'nor this one'));
    act(() => preview('a1', '   '));

    expect(rows()?.[0]?.lastMessage).toBe('something older');
  });

  it('does nothing at all before the list has ever loaded', () => {
    // Seeding a list the person has not fetched would put a one-agent list in
    // front of them the moment they spoke.
    const { preview, rows } = mount();

    act(() => preview('a1', 'what I just sent'));

    expect(rows()).toBeUndefined();
  });
});
