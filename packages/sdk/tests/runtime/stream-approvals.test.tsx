import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A coding CLI's question to its own user, as the stream carries it (ADR 0043 §5): the two named
 * events, `alia.approval_request` and `alia.approval_resolved`, and what the conversation keeps of
 * them from one turn to the next. The harness is `stream-host.test.tsx`'s.
 */

const harness = vi.hoisted(() => ({ responses: [] as string[][] }));

vi.mock('@oxy.so/services/ui/client', () => ({
  useAppAssertion: () => ({
    getAppAssertion: async () => 'assertion',
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({
    user: { id: 'u1' },
    oxyServices: {
      createLinkedClient: () => ({
        client: {
          getSessionEpoch: () => 0,
          addTokenChangeListener: () => () => {},
          requestAuthenticatedResponse: async () => {
            const frames = harness.responses.shift() ?? [];
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
                controller.close();
              },
            });
            return { ok: true, status: 200, body };
          },
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { GemieRuntimeProvider } from '../../src/runtime/config';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;

function Probe() {
  api = useConversationStream({ conversationId: 'c1', agentId: 'a-1' });
  return null;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <GemieRuntimeProvider apiUrl="http://api.test" host={{}}>
          <Probe />
        </GemieRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

const frame = (payload: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
const content = (text: string) => frame({ choices: [{ index: 0, delta: { content: text } }] });
const done = 'data: [DONE]\n\n';

const asks = (requestId: string, extra: object = {}) =>
  frame(
    {
      eventVersion: 1,
      requestId,
      agentId: 'a-1',
      tool: 'Bash',
      summary: 'bun test',
      expiresAt: '2026-11-26T12:00:00.000Z',
      ...extra,
    },
    'alia.approval_request',
  );
const answered = (requestId: string, decision: string) =>
  frame({ eventVersion: 1, requestId, decision }, 'alia.approval_resolved');

const send = (text: string) =>
  act(async () => {
    await api.append({ role: 'user', content: text });
  });

beforeEach(() => {
  harness.responses.length = 0;
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('approvals in the stream', () => {
  it('holds a question the CLI asked, waiting, with what it acts on', async () => {
    harness.responses.push([content('working'), asks('r-1'), done]);
    await mount();
    await send('run the tests');

    expect(api.approvals).toEqual([
      expect.objectContaining({
        requestId: 'r-1',
        agentId: 'a-1',
        tool: 'Bash',
        summary: 'bun test',
        outcome: 'pending',
      }),
    ]);
  });

  it('settles it when the stream says it was answered, or ran out of time', async () => {
    harness.responses.push([
      asks('r-1'),
      asks('r-2'),
      answered('r-1', 'allow'),
      answered('r-2', 'expired'),
      content('done'),
      done,
    ]);
    await mount();
    await send('go');

    expect(api.approvals.map((a) => [a.requestId, a.outcome])).toEqual([
      ['r-1', 'allow'],
      ['r-2', 'expired'],
    ]);
  });

  it('shows the same question once, and ignores frames that are not one', async () => {
    harness.responses.push([
      asks('r-1'),
      asks('r-1'),
      asks('r-bad', { tool: undefined }),
      asks('r-late', { expiresAt: 'whenever' }),
      answered('r-unknown', 'allow'),
      frame({ requestId: 'r-1', decision: 'maybe' }, 'alia.approval_resolved'),
      done,
    ]);
    await mount();
    await send('go');

    expect(api.approvals.map((a) => [a.requestId, a.outcome])).toEqual([['r-1', 'pending']]);
  });

  it('takes the person’s own answer at once', async () => {
    harness.responses.push([asks('r-1'), done]);
    await mount();
    await send('go');
    await act(async () => api.settleApproval('r-1', 'deny'));

    expect(api.approvals[0].outcome).toBe('deny');
  });

  it('keeps a question still waiting into the next turn, and drops the answered ones', async () => {
    harness.responses.push([asks('r-1'), asks('r-2'), answered('r-1', 'allow'), done]);
    harness.responses.push([content('next'), done]);
    await mount();
    await send('first');
    expect(api.approvals).toHaveLength(2);
    await send('second');

    expect(api.approvals.map((a) => a.requestId)).toEqual(['r-2']);
  });
});
