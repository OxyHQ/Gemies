import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listTerminalSessions,
  parseClaudeSession,
  parseCodexSession,
} from '../terminal-sessions.js';

let home: string;
let work: string;
let elsewhere: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gemies-ts-')));
  work = join(home, 'code', 'app');
  elsewhere = join(home, 'private');
  mkdirSync(work, { recursive: true });
  mkdirSync(elsewhere);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const jsonl = (...entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;

function claudeFile(project: string, id: string, cwd: string, text: string, mtime: number) {
  const dir = join(home, '.claude', 'projects', project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    jsonl(
      { type: 'mode', mode: 'normal', sessionId: id },
      { type: 'user', sessionId: id, cwd, message: { role: 'user', content: text } },
    ),
  );
  utimesSync(path, mtime / 1000, mtime / 1000);
}

function codexFile(id: string, cwd: string, text: string, mtime: number, extra: object = {}) {
  const dir = join(home, '.codex', 'sessions', '2026', '11', '14');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-11-14T12-30-27-${id}.jsonl`);
  writeFileSync(
    path,
    jsonl(
      { type: 'session_meta', payload: { id, cwd, ...extra } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }],
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      },
    ),
  );
  utimesSync(path, mtime / 1000, mtime / 1000);
}

describe('parsers', () => {
  it('reads a Claude Code session: its id, folder and the first thing the person typed', () => {
    const text = jsonl(
      { type: 'permission-mode', sessionId: 's-1' },
      { type: 'user', isSidechain: true, cwd: '/side', message: { content: 'agent prompt' } },
      {
        type: 'user',
        sessionId: 's-1',
        cwd: '/w',
        message: { content: [{ type: 'tool_result', content: 'x' }] },
      },
      {
        type: 'user',
        sessionId: 's-1',
        cwd: '/w',
        message: { content: '<command-name>/clear</command-name>' },
      },
      {
        type: 'user',
        sessionId: 's-1',
        cwd: '/w',
        message: { content: [{ type: 'text', text: 'fix the   login\nbug' }] },
      },
    );
    expect(parseClaudeSession(text)).toEqual({ id: 's-1', cwd: '/w', title: 'fix the login bug' });
  });

  it('reads a Codex session, skipping its own context blocks, and none a session spawned for itself', () => {
    const meta = { type: 'session_meta', payload: { id: 'c-1', cwd: '/w' } };
    const context = {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ text: '<environment_context/>' }] },
    };
    const typed = {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ text: 'add tests' }] },
    };
    expect(parseCodexSession(jsonl(meta, context, typed))).toEqual({
      id: 'c-1',
      cwd: '/w',
      title: 'add tests',
    });
    const sub = {
      type: 'session_meta',
      payload: { id: 'c-2', cwd: '/w', source: { subagent: {} } },
    };
    expect(parseCodexSession(jsonl(sub, typed))).toBeNull();
  });

  it('survives lines that do not parse, and files with no session in them', () => {
    expect(parseClaudeSession('not json\n{"broken\n')).toBeNull();
    expect(parseCodexSession('')).toBeNull();
  });
});

describe('listTerminalSessions', () => {
  it('lists Claude and Codex sessions in allowed folders only, newest first', () => {
    claudeFile('-a', 'claude-old-0001', work, 'old one', 1_000_000);
    claudeFile('-a', 'claude-new-0002', work, 'new one', 3_000_000);
    claudeFile('-b', 'claude-priv-0003', elsewhere, 'private', 4_000_000);
    codexFile('codex-0000-0001', work, 'codex one', 2_000_000);

    const claude = listTerminalSessions({ cli: 'claude', roots: [work], home, env: {} });
    expect(claude.map((s) => [s.id, s.title, s.cwd])).toEqual([
      ['claude-new-0002', 'new one', work],
      ['claude-old-0001', 'old one', work],
    ]);
    expect(claude[0].updatedAt).toBe(3_000_000);

    const codex = listTerminalSessions({ cli: 'codex', roots: [work], home, env: {} });
    expect(codex.map((s) => [s.id, s.title])).toEqual([['codex-0000-0001', 'codex one']]);
  });

  it('offers nothing when no folder is allowed, and nothing for OpenCode', () => {
    claudeFile('-a', 'claude-new-0002', work, 'new one', 3_000_000);
    expect(listTerminalSessions({ cli: 'claude', roots: [], home, env: {} })).toEqual([]);
    expect(listTerminalSessions({ cli: 'opencode', roots: [work], home, env: {} })).toEqual([]);
  });

  it('never offers an id that could not be a session id', () => {
    claudeFile('-a', 'ok-session-0001', work, 'fine', 1_000_000);
    const dir = join(home, '.claude', 'projects', '-a');
    writeFileSync(
      join(dir, 'weird.jsonl'),
      jsonl({
        type: 'user',
        sessionId: '--dangerous; rm -rf',
        cwd: work,
        message: { content: 'x' },
      }),
    );
    expect(
      listTerminalSessions({ cli: 'claude', roots: [work], home, env: {} }).map((s) => s.id),
    ).toEqual(['ok-session-0001']);
  });

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    const other = join(home, 'elsewhere-claude');
    mkdirSync(join(other, 'projects', '-x'), { recursive: true });
    writeFileSync(
      join(other, 'projects', '-x', 'moved-session-1.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'moved-session-1',
        cwd: work,
        message: { content: 'moved' },
      }),
    );
    const found = listTerminalSessions({
      cli: 'claude',
      roots: [work],
      home,
      env: { CLAUDE_CONFIG_DIR: other },
    });
    expect(found.map((s) => s.id)).toEqual(['moved-session-1']);
  });
});
