import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A coding CLI asking its own user for permission, in the thread (ADR 0043 §5). The rules under
 * test: a waiting question says who asks, for what, and offers Allow and Deny; an answer is sent
 * once however often it is pressed, and nothing is offered while it is on its way; a question that
 * is no longer open reads as timed out; one that could not be sent can be tried again; an answered
 * question is one quiet line. Bloom's card is a recorder: what is asserted is what the thread asks
 * it to draw.
 */

const drawn = vi.hoisted(() => ({
  notification: null as null | {
    title: string;
    description?: string;
    actions?: { label: string; onPress: () => void }[];
  },
  line: null as null | string,
}));

vi.mock('react-native', async () => ({
  ...(await import('../../support/style-stubs')).reactNativeStyles,
  View: (props: { children?: React.ReactNode }) => props.children ?? null,
}));
vi.mock('@oxy.so/bloom/notification', () => ({
  Notification: (props: NonNullable<typeof drawn.notification>) => {
    drawn.notification = props;
    return null;
  },
}));
vi.mock('@oxy.so/bloom/typography', () => ({
  Muted: ({ children }: { children: string }) => {
    drawn.line = children;
    return null;
  },
}));
vi.mock('../../../src/lib/labels', () => ({
  useLabels: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  }),
}));

import { ApprovalCards } from '../../../src/components/thread/ApprovalCard';
import { ApprovalExpiredError, type ApprovalEntry } from '../../../src/runtime/approvals';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const entry = (outcome: ApprovalEntry['outcome'] = 'pending'): ApprovalEntry => ({
  requestId: 'r-1',
  agentId: 'a-1',
  tool: 'Bash',
  summary: 'bun test',
  expiresAt: '2026-11-26T12:00:00.000Z',
  outcome,
});

const onSettled = vi.fn();
let renderer: ReactTestRenderer | null = null;

async function show(props: Partial<React.ComponentProps<typeof ApprovalCards>> = {}) {
  await act(async () => {
    const element = (
      <ApprovalCards entries={[entry()]} agentName="Claude Code" onSettled={onSettled} {...props} />
    );
    if (renderer === null) renderer = create(element);
    else renderer.update(element);
  });
}

const press = async (label: string) => {
  const action = drawn.notification?.actions?.find((a) => a.label === label);
  await act(async () => action?.onPress());
};

beforeEach(() => {
  drawn.notification = null;
  drawn.line = null;
  onSettled.mockReset();
  renderer = null;
});

describe('ApprovalCards', () => {
  it('says who asks and for what, with Allow and Deny', async () => {
    await show({ onDecide: vi.fn(async () => {}) });

    expect(drawn.notification?.title).toBe(
      'chat.approval.title {"agent":"Claude Code","tool":"Bash"}',
    );
    expect(drawn.notification?.description).toBe('bun test');
    expect(drawn.notification?.actions?.map((a) => a.label)).toEqual([
      'chat.approval.deny',
      'chat.approval.allow',
    ]);
  });

  it('sends the answer once and settles on it, whatever else is pressed meanwhile', async () => {
    let finish: () => void = () => {};
    const onDecide = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await show({ onDecide });

    await press('chat.approval.allow');
    // While it is on its way there is nothing left to press.
    expect(drawn.notification?.actions).toBeUndefined();
    await act(async () => finish());

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r-1' }), 'allow');
    expect(onSettled).toHaveBeenCalledExactlyOnceWith('r-1', 'allow');
  });

  it('sends a denial as a denial', async () => {
    const onDecide = vi.fn(async () => {});
    await show({ onDecide });
    await press('chat.approval.deny');
    expect(onDecide).toHaveBeenCalledWith(expect.anything(), 'deny');
    expect(onSettled).toHaveBeenCalledWith('r-1', 'deny');
  });

  it('reads as timed out when the question is no longer open', async () => {
    await show({
      onDecide: vi.fn(async () => {
        throw new ApprovalExpiredError();
      }),
    });
    await press('chat.approval.allow');
    expect(onSettled).toHaveBeenCalledExactlyOnceWith('r-1', 'expired');
  });

  it('says the answer could not be sent, and offers the two again', async () => {
    const onDecide = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce();
    await show({ onDecide });
    await press('chat.approval.allow');

    expect(onSettled).not.toHaveBeenCalled();
    expect(drawn.notification?.description).toContain('chat.approval.sendFailed');
    expect(drawn.notification?.actions).toHaveLength(2);

    await press('chat.approval.allow');
    expect(onSettled).toHaveBeenCalledExactlyOnceWith('r-1', 'allow');
  });

  it('shows the question with no way to answer it when the host cannot carry the answer', async () => {
    await show();
    expect(drawn.notification?.title).toContain('chat.approval.title');
    expect(drawn.notification?.actions).toBeUndefined();
  });

  it('shrinks an answered question to one line saying how it ended', async () => {
    for (const outcome of ['allow', 'deny', 'expired'] as const) {
      drawn.notification = null;
      await show({ entries: [entry(outcome)], onDecide: vi.fn(async () => {}) });
      expect(drawn.notification).toBeNull();
      expect(drawn.line).toBe(`chat.approval.resolved.${outcome} {"tool":"Bash"}`);
    }
  });
});
