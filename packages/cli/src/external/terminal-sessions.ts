/**
 * The sessions a CLI already has on this computer, so one begun in a terminal can be continued from
 * Gemies (ADR 0043 §4). Read from the CLI's own files, best effort: their format is theirs, so a
 * file that does not parse is skipped, never an error. Only sessions whose folder this computer
 * allows are offered (`roots.ts`), and only what the app shows is read: a title, a folder, a time.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionCwd } from './roots.js';
import type { ExternalCli } from './types.js';

export interface TerminalSession {
  /** The CLI's own id for it: what `--resume` takes. */
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  /** Milliseconds since the epoch: when the file last changed. */
  readonly updatedAt: number;
}

/** The most sessions one listing returns, newest first. */
export const MAX_TERMINAL_SESSIONS = 40;
/** How much of a session file is read to find its folder and first message. */
const HEAD_BYTES = 256 * 1024;
const TITLE_CHARS = 80;
/** A session id as both CLIs write it; anything else is never offered, so it cannot reach a command line. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;

function head(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object')
        out.push(parsed as Record<string, unknown>);
    } catch {
      // A line cut off at the end of what was read, or one this reader does not know.
    }
  }
  return out;
}

function titleOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > TITLE_CHARS ? `${one.slice(0, TITLE_CHARS - 1)}…` : one;
}

/** The text of a Claude Code user message that a person typed (not a tool result or a command echo). */
function claudeUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join(' ');
}

export function parseClaudeSession(
  text: string,
): { id: string; cwd: string; title: string } | null {
  let id = '';
  let cwd = '';
  let title = '';
  for (const entry of lines(text)) {
    if (!id && typeof entry.sessionId === 'string') id = entry.sessionId;
    if (entry.isSidechain === true) continue;
    if (entry.type !== 'user') continue;
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
    if (!title && entry.isMeta !== true) {
      const message = entry.message as { content?: unknown } | undefined;
      const typed = claudeUserText(message?.content).trim();
      // Slash commands and their output are wrapped in tags; they are not what the session is about.
      if (typed && !typed.startsWith('<')) title = titleOf(typed);
    }
    if (id && cwd && title) break;
  }
  return id && cwd ? { id, cwd, title: title || id.slice(0, 8) } : null;
}

export function parseCodexSession(text: string): { id: string; cwd: string; title: string } | null {
  let id = '';
  let cwd = '';
  let title = '';
  for (const entry of lines(text)) {
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (entry.type === 'session_meta' && !id) {
      // A session a running one spawned for itself is not one a person started.
      const source = payload.source as { subagent?: unknown } | undefined;
      if (source && typeof source === 'object' && source.subagent !== undefined) return null;
      if (typeof payload.id === 'string') id = payload.id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
    }
    if (
      !title &&
      entry.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content)
    ) {
      const typed = payload.content
        .map((part) =>
          part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : '',
        )
        .join(' ')
        .trim();
      // Codex opens a session with context blocks of its own, in tags or as the repo's instructions.
      if (typed && !typed.startsWith('<') && !typed.startsWith('# AGENTS.md instructions')) {
        title = titleOf(typed);
      }
    }
    if (id && cwd && title) break;
  }
  return id && cwd ? { id, cwd, title: title || id.slice(0, 8) } : null;
}

function jsonlFiles(dir: string, depth: number): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) out.push(...jsonlFiles(path, depth - 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        out.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // Gone since it was listed.
      }
    }
  }
  return out;
}

/**
 * The CLI's sessions in the folders this computer allows, newest first. OpenCode keeps none this
 * reader understands, so it lists none.
 */
export function listTerminalSessions(input: {
  cli: ExternalCli;
  roots: readonly string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
}): TerminalSession[] {
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  let files: { path: string; mtime: number }[];
  let parse: (text: string) => { id: string; cwd: string; title: string } | null;
  if (input.cli === 'claude') {
    files = jsonlFiles(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'), 1);
    parse = parseClaudeSession;
  } else if (input.cli === 'codex') {
    files = jsonlFiles(join(env.CODEX_HOME || join(home, '.codex'), 'sessions'), 4);
    parse = parseCodexSession;
  } else {
    return [];
  }

  const sessions: TerminalSession[] = [];
  const seen = new Set<string>();
  for (const file of files.sort((a, b) => b.mtime - a.mtime)) {
    if (sessions.length >= MAX_TERMINAL_SESSIONS) break;
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(head(file.path));
    } catch {
      continue;
    }
    if (!parsed || !SESSION_ID.test(parsed.id) || seen.has(parsed.id)) continue;
    const allowed = resolveSessionCwd(parsed.cwd, input.roots, home);
    if (!allowed.ok) continue;
    seen.add(parsed.id);
    sessions.push({ id: parsed.id, cwd: allowed.cwd, title: parsed.title, updatedAt: file.mtime });
  }
  return sessions;
}
