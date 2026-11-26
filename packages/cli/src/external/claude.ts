import { claudeActivity } from './activity.js';
import { APPROVAL_TOKEN_ENV } from './approval-server.js';
import { claudeMcpArgs, toolsEnv } from './gemie-tools.js';
import { lineSplitter, runProcess, tail } from './process.js';
import type { ActivityEvent, ExternalRuntime } from './types.js';

/**
 * Claude Code, as the person's own installed `claude` binary: `claude -p` with their login. The
 * answer streams as `stream_event` deltas and ends with a `result` line.
 */
export function claudeRuntime(command = 'claude'): ExternalRuntime {
  return {
    resumes: true,
    approvals: true,
    async run({
      prompt,
      cwd,
      write,
      signal,
      onDelta,
      onActivity,
      resumeId,
      onSession,
      tools,
      approvals,
    }) {
      let streamed = '';
      const openTools = new Map<string, ActivityEvent>();
      let result: { text: string; isError: boolean } | null = null;
      const onLine = (line: string): void => {
        if (line.trim() === '') return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event === null || typeof event !== 'object') return;
        const e = event as Record<string, unknown>;
        if (onActivity && (e.type === 'assistant' || e.type === 'user')) {
          for (const activity of claudeActivity(e, openTools)) onActivity(activity);
        }
        if (e.type === 'stream_event') {
          const inner = e.event as { type?: string; delta?: { type?: string; text?: string } };
          if (
            inner?.type === 'content_block_delta' &&
            inner.delta?.type === 'text_delta' &&
            typeof inner.delta.text === 'string'
          ) {
            streamed += inner.delta.text;
            onDelta(inner.delta.text);
          }
        } else if (e.type === 'result') {
          if (typeof e.session_id === 'string') onSession?.(e.session_id);
          result = {
            text: typeof e.result === 'string' ? e.result : '',
            isError: e.is_error === true,
          };
        }
      };
      const lines = lineSplitter(onLine);
      const out = await runProcess({
        command,
        args: [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--permission-mode',
          write ? 'acceptEdits' : 'default',
          ...(resumeId ? ['--resume', resumeId] : []),
          // Last: `--allowedTools` takes every argument after it, and the prompt is on stdin.
          ...claudeMcpArgs({ ...(tools ? { tools } : {}), ...(approvals ? { approvals } : {}) }),
        ],
        cwd,
        ...(tools || approvals
          ? {
              env: {
                ...(tools ? toolsEnv(tools) : process.env),
                ...(approvals ? { [APPROVAL_TOKEN_ENV]: approvals.token } : {}),
              },
            }
          : {}),
        stdin: prompt,
        signal,
        onStdout: lines.push,
      });
      lines.flush();
      const final = result as { text: string; isError: boolean } | null;
      if (final?.isError) throw new Error(final.text || 'Claude Code reported an error');
      if (out.code !== 0 && final === null) {
        throw new Error(`claude exited with ${out.code}: ${tail(out.stderr || out.stdout)}`);
      }
      const text = final?.text || streamed;
      if (final !== null && streamed === '' && text !== '') onDelta(text);
      return text;
    },
  };
}
