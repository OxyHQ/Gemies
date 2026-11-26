import { describe, expect, it } from 'vitest';
import { claudeActivity, codexActivity } from '../activity.js';
import type { ActivityEvent } from '../types.js';

/** Shapes captured from the installed `claude` and `codex` (`-p stream-json --verbose`, `exec --json`). */

describe('claudeActivity', () => {
  const use = (id: string, name: string, input: object) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
  const result = (id: string, isError = false) => ({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: id, content: 'SECRET OUTPUT', is_error: isError },
      ],
    },
  });

  it('reports a tool starting, then the same call finishing, with its target and no output', () => {
    const open = new Map<string, ActivityEvent>();
    expect(claudeActivity(use('t1', 'Read', { file_path: '/w/a.txt' }), open)).toEqual([
      { id: 't1', tool: 'Read', summary: '/w/a.txt', status: 'running' },
    ]);
    const done = claudeActivity(result('t1'), open);
    expect(done).toEqual([{ id: 't1', tool: 'Read', summary: '/w/a.txt', status: 'done' }]);
    expect(JSON.stringify(done)).not.toContain('SECRET');
    expect(open.size).toBe(0);
  });

  it('marks a failed call, and picks the command of Bash over everything else', () => {
    const open = new Map<string, ActivityEvent>();
    claudeActivity(
      use('t2', 'Bash', { command: 'bun   test\n--watch', description: 'Run tests' }),
      open,
    );
    expect(claudeActivity(result('t2', true), open)).toEqual([
      { id: 't2', tool: 'Bash', summary: 'bun test --watch', status: 'error' },
    ]);
  });

  it('ignores text blocks, results of calls it never saw, and anything that is not an event', () => {
    const open = new Map<string, ActivityEvent>();
    expect(
      claudeActivity(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        open,
      ),
    ).toEqual([]);
    expect(claudeActivity(result('unknown'), open)).toEqual([]);
    expect(claudeActivity(null, open)).toEqual([]);
    expect(claudeActivity({ type: 'result' }, open)).toEqual([]);
  });

  it('shortens a long target', () => {
    const [started] = claudeActivity(use('t3', 'Bash', { command: 'x'.repeat(500) }), new Map());
    expect(started.summary?.length).toBe(160);
    expect(started.summary?.endsWith('…')).toBe(true);
  });
});

describe('codexActivity', () => {
  it('reports a command starting and finishing, without the shell wrapper or its output', () => {
    const started = codexActivity({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: "/bin/bash -lc 'cat a.txt'",
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    });
    expect(started).toEqual([
      { id: 'item_1', tool: 'Shell', summary: 'cat a.txt', status: 'running' },
    ]);
    const done = codexActivity({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: "/bin/bash -lc 'cat a.txt'",
        aggregated_output: 'SECRET\n',
        exit_code: 0,
        status: 'completed',
      },
    });
    expect(done).toEqual([{ id: 'item_1', tool: 'Shell', summary: 'cat a.txt', status: 'done' }]);
    expect(JSON.stringify(done)).not.toContain('SECRET');
  });

  it('marks a command that exited non-zero as failed', () => {
    const [failed] = codexActivity({
      type: 'item.completed',
      item: {
        id: 'i',
        type: 'command_execution',
        command: 'false',
        exit_code: 1,
        status: 'completed',
      },
    });
    expect(failed.status).toBe('error');
  });

  it('names the files of a change, a web search and a tool call', () => {
    expect(
      codexActivity({
        type: 'item.completed',
        item: {
          id: 'f',
          type: 'file_change',
          status: 'completed',
          changes: [
            { path: 'a.ts', kind: 'update' },
            { path: 'b.ts', kind: 'add' },
          ],
        },
      }),
    ).toEqual([{ id: 'f', tool: 'Edit', summary: 'a.ts, b.ts', status: 'done' }]);
    expect(
      codexActivity({
        type: 'item.started',
        item: { id: 'w', type: 'web_search', query: 'bun docs' },
      }),
    ).toEqual([{ id: 'w', tool: 'Web search', summary: 'bun docs', status: 'running' }]);
    expect(
      codexActivity({
        type: 'item.completed',
        item: {
          id: 'm',
          type: 'mcp_tool_call',
          server: 'gemies',
          tool: 'sendMessage',
          status: 'completed',
        },
      }),
    ).toEqual([{ id: 'm', tool: 'gemies · sendMessage', status: 'done' }]);
  });

  it('says nothing about the agent’s own messages, reasoning, or events it does not know', () => {
    expect(
      codexActivity({
        type: 'item.completed',
        item: { id: 'a', type: 'agent_message', text: 'hello' },
      }),
    ).toEqual([]);
    expect(codexActivity({ type: 'thread.started', thread_id: 'x' })).toEqual([]);
    expect(codexActivity({ type: 'item.started', item: { type: 'command_execution' } })).toEqual(
      [],
    );
    expect(codexActivity('junk')).toEqual([]);
  });
});
