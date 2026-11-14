/**
 * A consulted agent's answer is recorded as THAT AGENT's message, not as a
 * tool result the lead paraphrases (ADR 0020 §5).
 *
 * `consultAgent` emits the answer live itself (`alia.agent_start|delta|tool|end`) and hands the
 * turn that agent's message, whole, with what it drew (`lib/tools/consult-agent.ts`). The stream
 * loop writes no frame for it and rebuilds no message from the tool's result, which the tool budget
 * has bounded for the model; it keeps the result as the lead's record of the call.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      v1: child,
      chat: child,
      general: child,
      agents: child,
      credits: child,
      providers: child,
    },
  };
});
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');

const ANSWER = {
  agentId: 'ag-1',
  agentName: 'Sindi',
  agentHandle: 'sindibot',
  agentColor: 'teal',
  agentCharacter: null,
  response: 'Hay tres pisos en Gràcia.',
};

const FINISH = { type: 'finish', finishReason: 'stop', totalUsage: {} };

async function run(toolName: string, output: unknown) {
  const { written, agentMessages, toolInvocations } = await runChunks([
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: {} },
    { type: 'tool-result', toolCallId: 'call-1', toolName, input: {}, output },
  ]);
  return { written, agentMessages, toolInvocations };
}

describe('a consulted agent is recorded as that agent', () => {
  it("keeps consultAgent's result as the lead's record, with no frame and no message of its own", async () => {
    const { written, agentMessages, toolInvocations } = await run('consultAgent', ANSWER);

    expect(agentMessages).toEqual([]);
    expect(toolInvocations).toEqual([
      expect.objectContaining({ toolName: 'consultAgent', state: 'result', result: ANSWER }),
    ]);
    expect(written.some((frame) => frame.startsWith('event: alia.agent\n'))).toBe(false);
  });

  it('counts an answer the tool handed the turn as the turn having answered', async () => {
    const answer = {
      role: 'assistant' as const,
      content: ANSWER.response,
      agentInfo: { id: 'ag-1', name: 'Sindi', color: 'teal', character: null, handle: 'sindibot' },
    };
    // Nothing of the lead's own, and no tool call: without the agent's answer this turn is empty.
    await expect(
      runChunks([FINISH], undefined, undefined, { agentMessages: [answer] }),
    ).resolves.toBeDefined();
    await expect(runChunks([FINISH])).rejects.toThrow();
  });
});
