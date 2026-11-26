/**
 * What a CLI is doing, as the conversation shows it (Gemies ADR 0043 §5): one line per tool it
 * uses, started and then finished. Read from each CLI's own event stream, best effort: a line this
 * reader does not know is skipped. What is sent is a title and a short target (a path, a command, a
 * pattern), never a file's contents or a command's output.
 */
import type { ActivityEvent } from './types.js';

const MAX_SUMMARY = 160;

function short(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const one = value.replace(/\s+/g, ' ').trim();
  if (one === '') return undefined;
  return one.length > MAX_SUMMARY ? `${one.slice(0, MAX_SUMMARY - 1)}…` : one;
}

/** The part of a Claude Code tool's input that says what it acts on. */
export function claudeTarget(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  return (
    short(i.command) ??
    short(i.file_path) ??
    short(i.path) ??
    short(i.pattern) ??
    short(i.url) ??
    short(i.query) ??
    short(i.description) ??
    short(i.prompt)
  );
}

/**
 * Activity from one Claude Code `stream-json` event. `assistant` messages carry `tool_use` blocks
 * (a tool starting); `user` messages carry the matching `tool_result` (it finished). `names` keeps
 * the tool of each call, so a result can say which one it closes.
 */
export function claudeActivity(event: unknown, names: Map<string, ActivityEvent>): ActivityEvent[] {
  if (event === null || typeof event !== 'object') return [];
  const e = event as { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
  if (e.type !== 'assistant' && e.type !== 'user') return [];
  const content = e.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ActivityEvent[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (e.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string') {
      const started: ActivityEvent = {
        id: b.id,
        tool: typeof b.name === 'string' ? b.name : 'tool',
        ...(claudeTarget(b.input) ? { summary: claudeTarget(b.input) as string } : {}),
        status: 'running',
      };
      names.set(b.id, started);
      out.push(started);
    } else if (e.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const started = names.get(b.tool_use_id);
      if (!started) continue;
      names.delete(b.tool_use_id);
      out.push({ ...started, status: b.is_error === true ? 'error' : 'done' });
    }
  }
  return out;
}

/** `/bin/bash -lc 'cat a.txt'` is Codex wrapping a command in a shell; the person wrote `cat a.txt`. */
function unwrapShell(command: string): string {
  const match = /^(?:\/\S+\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return match ? match[2] : command;
}

/**
 * Activity from one Codex `exec --json` event: `item.started` and `item.completed` for the items
 * that are work (a command, a file change, a tool call, a web search), not for its messages.
 */
export function codexActivity(event: unknown): ActivityEvent[] {
  if (event === null || typeof event !== 'object') return [];
  const e = event as { type?: unknown; item?: unknown };
  if ((e.type !== 'item.started' && e.type !== 'item.completed') || e.item === null) return [];
  if (typeof e.item !== 'object') return [];
  const item = e.item as Record<string, unknown>;
  if (typeof item.id !== 'string') return [];
  const running = e.type === 'item.started';

  let tool: string | undefined;
  let summary: string | undefined;
  let failed = false;
  switch (item.type) {
    case 'command_execution':
      tool = 'Shell';
      summary = short(typeof item.command === 'string' ? unwrapShell(item.command) : undefined);
      failed = typeof item.exit_code === 'number' && item.exit_code !== 0;
      break;
    case 'file_change': {
      tool = 'Edit';
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((c) => (c && typeof c === 'object' ? (c as { path?: unknown }).path : undefined))
        .filter((p): p is string => typeof p === 'string');
      summary = short(
        paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` +${paths.length - 3}` : ''),
      );
      failed = item.status === 'failed';
      break;
    }
    case 'mcp_tool_call':
      tool =
        [item.server, item.tool].filter((x): x is string => typeof x === 'string').join(' · ') ||
        'Tool';
      failed = item.status === 'failed';
      break;
    case 'web_search':
      tool = 'Web search';
      summary = short(item.query);
      break;
    default:
      return [];
  }
  return [
    {
      id: item.id,
      tool,
      ...(summary ? { summary } : {}),
      status: running ? 'running' : failed ? 'error' : 'done',
    },
  ];
}
