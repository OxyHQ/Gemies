/**
 * A 1:1 turn with an external agent (ADR 0030, 0043): the stream the app renders, with the CLI's work
 * shown as tool steps, and what the conversation keeps. The rules under test: a session's folder and
 * terminal session ride on the turn; each tool the CLI uses is one call and one result in the same
 * frames any tool's work uses; only what the daemon reported is sent; the conversation keeps the
 * tools beside the answer; a turn that fails writes no result for a call it never finished.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalActivity } from '../../../domain/external-agent.js';

const state = vi.hoisted(() => ({
  session: undefined as { cwd: string; cliSessionId: string | null } | undefined,
  run: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/externalAgentRepository.js', () => ({
  findExternalSession: async () => state.session,
}));
vi.mock('../turn.js', () => ({ runExternalAgentTurn: state.run }));
vi.mock('../../chat-lifecycle.js', () => ({ saveConversationResult: state.save }));

import { serveExternalDirectTurn } from '../direct-turn.js';

function fakeResponse() {
  const writes: string[] = [];
  return {
    writes,
    writableEnded: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    status: () => ({ json: vi.fn() }),
    json: vi.fn(),
  };
}

const sse = {
  ensureHeaders: vi.fn(),
  startKeepAlive: vi.fn(),
  stopKeepAlive: vi.fn(),
  done: vi.fn(),
  sent: true,
  writeError: vi.fn(),
};

const call = (activity: ExternalActivity[], response = 'all done') => {
  state.run.mockImplementation(async (input: { onActivity?: (a: ExternalActivity) => void }) => {
    for (const a of activity) input.onActivity?.(a);
    return { response, tokensUsed: 0, creditsCharged: 0 };
  });
};

async function serve(res: ReturnType<typeof fakeResponse>, extra: object = {}) {
  const activity = { set: vi.fn(), end: vi.fn() };
  const answered = await serveExternalDirectTurn({
    req: {} as never,
    res: res as never,
    sse: sse as never,
    requestId: 'req-1',
    modelId: 'model-x',
    stream: true,
    agentId: 'agent-1',
    messages: [{ role: 'user', content: 'fix the bug' }],
    lifecycle: { conversationId: 'conv-1', userId: 'u1' } as never,
    signal: new AbortController().signal,
    activity: activity as never,
    ...extra,
  });
  return { answered, activity };
}

const frames = (res: ReturnType<typeof fakeResponse>) =>
  res.writes.map((w) => {
    const event = /^event: (\S+)\n/.exec(w)?.[1];
    return {
      event,
      data: JSON.parse(
        w
          .replace(/^event: \S+\n/, '')
          .replace(/^data: /, '')
          .trim() || 'null',
      ),
    };
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.session = undefined;
});

describe('serveExternalDirectTurn', () => {
  it('hands the session’s folder and terminal session to the turn', async () => {
    state.session = { cwd: '/home/ana/app', cliSessionId: 'terminal-session-1' };
    call([]);
    await serve(fakeResponse());
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        threadKey: 'conv-1',
        cwd: '/home/ana/app',
        resumeId: 'terminal-session-1',
      }),
    );
  });

  it('sends neither for a conversation that is not a session', async () => {
    call([]);
    await serve(fakeResponse());
    expect(state.run.mock.calls[0][0]).not.toHaveProperty('cwd');
    expect(state.run.mock.calls[0][0]).not.toHaveProperty('resumeId');
  });

  it('shows each tool as a call and then its result, in the frames any tool uses', async () => {
    call([
      { id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'running' },
      { id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'done' },
      { id: 'b', tool: 'Bash', summary: 'bun test', status: 'running' },
      { id: 'b', tool: 'Bash', summary: 'bun test', status: 'error' },
    ]);
    const res = fakeResponse();
    await serve(res);
    const toolFrames = frames(res).filter(
      (f) => f.event === 'alia.tool_result' || f.data?.choices?.[0]?.delta?.tool_calls,
    );
    expect(toolFrames).toHaveLength(4);
    const first = toolFrames[0].data.choices[0].delta.tool_calls[0];
    expect(first).toMatchObject({
      index: 0,
      id: 'ext_a',
      type: 'function',
      function: { name: 'Read', arguments: JSON.stringify({ summary: '/w/a.txt' }) },
    });
    expect(toolFrames[1]).toEqual({
      event: 'alia.tool_result',
      data: {
        eventVersion: 1,
        tool_call_id: 'ext_a',
        name: 'Read',
        output: { status: 'done', summary: '/w/a.txt' },
      },
    });
    expect(toolFrames[2].data.choices[0].delta.tool_calls[0].index).toBe(1);
    expect(toolFrames[3].data.output.status).toBe('error');
  });

  it('keeps the tools beside the answer, and tells the person’s other screens a tool is in use', async () => {
    call([
      { id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'running' },
      { id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'done' },
    ]);
    const { activity } = await serve(fakeResponse());
    expect(state.save).toHaveBeenCalledWith(expect.anything(), 'all done', [
      {
        toolCallId: 'ext_a',
        toolName: 'Read',
        state: 'result',
        args: { summary: '/w/a.txt' },
        result: { status: 'done', summary: '/w/a.txt' },
      },
    ]);
    expect(activity.set).toHaveBeenCalledWith('tool', 'Read');
  });

  it('saves a turn with no tools as it always did', async () => {
    call([]);
    await serve(fakeResponse());
    expect(state.save).toHaveBeenCalledWith(expect.anything(), 'all done', undefined);
  });

  it('leaves a call that never finished without a result, and does not save a failed turn', async () => {
    state.run.mockImplementation(async (input: { onActivity?: (a: ExternalActivity) => void }) => {
      input.onActivity?.({ id: 'a', tool: 'Bash', summary: 'sleep 100', status: 'running' });
      return { response: '', tokensUsed: 0, creditsCharged: 0, error: 'offline' };
    });
    const res = fakeResponse();
    const { answered } = await serve(res);
    expect(answered).toBe(false);
    expect(frames(res).some((f) => f.event === 'alia.tool_result')).toBe(false);
    expect(state.save).not.toHaveBeenCalled();
  });
});
