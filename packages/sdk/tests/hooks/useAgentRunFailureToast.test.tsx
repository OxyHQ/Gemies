import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_ACTIVITY, type AgentActivityState } from '../../src/runtime/thread/agent-activity';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const toast = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
// As the real hook does, one `t` across renders.
const labels = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('../../src/lib/labels', () => ({ useLabels: () => labels }));

import { useAgentRunFailureToast } from '../../src/hooks/useAgentRunFailureToast';
import { FAILED_TURN_TOAST_ID } from '../../src/hooks/useFailedTurnToast';

let renderer: TestRenderer.ReactTestRenderer | null = null;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
});

const run = (over: Partial<AgentActivityState>): AgentActivityState => ({
  ...INITIAL_ACTIVITY,
  eventCount: 3,
  isComplete: true,
  ...over,
});

function mount(activity: AgentActivityState | null, failedTurn?: unknown) {
  function Probe({ a, f }: { a: AgentActivityState | null; f?: unknown }) {
    useAgentRunFailureToast(a, f);
    return null;
  }
  act(() => {
    renderer = TestRenderer.create(<Probe a={activity} f={failedTurn} />);
  });
  return (next: AgentActivityState | null, f?: unknown) =>
    act(() => renderer?.update(<Probe a={next} f={f} />));
}

describe('useAgentRunFailureToast', () => {
  it('tells a run that failed with one toast carrying the reason, and no panel', () => {
    mount(run({ hasError: true, lastError: 'The external agent did not answer' }));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      'chat.agentRun.taskFailed',
      expect.objectContaining({
        id: FAILED_TURN_TOAST_ID,
        description: 'The external agent did not answer',
      }),
    );
  });

  it('tells a run that failed before it closed, with no panel waiting for it to finish', () => {
    mount(run({ isComplete: false, hasError: true, lastError: 'open' }));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('says nothing for a run that is going, ended well, or never was', () => {
    mount(run({ isComplete: false, hasError: false }));
    mount(run({ hasError: false }));
    mount(null);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not tell it twice for the same run, and again for the next one', () => {
    const update = mount(run({ hasError: true, lastError: 'first' }));
    update(run({ hasError: true, lastError: 'first', eventCount: 4 }));
    expect(toast.error).toHaveBeenCalledTimes(1);
    update(run({ hasError: true, lastError: 'second' }));
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  it('leaves it to the turn’s own failure toast when the turn failed too', () => {
    mount(run({ hasError: true, lastError: 'x' }), { userMessageId: 'm1' });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
