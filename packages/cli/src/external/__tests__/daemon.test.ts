import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon, type Daemon } from '../daemon.js';
import type { SessionStore } from '../state.js';
import { framePrompt } from '../prompt.js';
import { runProcess } from '../process.js';
import type { ExternalRuntime, RuntimeRun } from '../types.js';

let wss: WebSocketServer;
let url: string;
let peers: ServerSocket[] = [];
let received: Record<string, unknown>[] = [];
let daemon: Daemon | undefined;

beforeEach(async () => {
  peers = [];
  received = [];
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  wss.on('connection', (ws) => {
    peers.push(ws);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      received.push(frame);
      if (frame.type === 'auth')
        ws.send(JSON.stringify({ type: 'auth-ok', agentId: frame.agentId }));
    });
  });
});

afterEach(async () => {
  daemon?.stop();
  for (const peer of peers) peer.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function start(runtime: ExternalRuntime, extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  daemon = startDaemon({
    wsUrl: url,
    agentId: 'agent-1',
    agentName: 'Codex · laptop',
    runtime,
    cwd: '/tmp',
    write: false,
    credential: 'gxa_agent-1',
    minBackoffMs: 20,
    maxBackoffMs: 40,
    ...extra,
  });
  return daemon;
}

const echo: ExternalRuntime = {
  resumes: false,
  async run({ prompt, onDelta }: RuntimeRun) {
    onDelta('he');
    onDelta('llo');
    return `hello <- ${prompt.includes('say hi') ? 'asked' : 'unasked'}`;
  },
};

describe('daemon', () => {
  it('authenticates with the agent’s own credential, and nothing of an Oxy session', async () => {
    start(echo);
    await until(() => received.some((f) => f.type === 'auth'));
    expect(received[0]).toEqual({ type: 'auth', agentId: 'agent-1', credential: 'gxa_agent-1' });
  });

  it('presents the same credential again after a restart of the connection', async () => {
    start(echo);
    await until(() => peers.length === 1 && received.length === 1);
    peers[0].terminate();
    await until(() => received.filter((f) => f.type === 'auth').length === 2);
    expect(received.filter((f) => f.type === 'auth')).toEqual([
      { type: 'auth', agentId: 'agent-1', credential: 'gxa_agent-1' },
      { type: 'auth', agentId: 'agent-1', credential: 'gxa_agent-1' },
    ]);
  });

  it('answers a turn: deltas then end with the full text and a framed prompt', async () => {
    start(echo);
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'say hi', history: [] }));
    await until(() => received.some((f) => f.type === 'end'));
    expect(received.filter((f) => f.type === 'delta').map((f) => f.text)).toEqual(['he', 'llo']);
    expect(received.find((f) => f.type === 'end')).toEqual({
      type: 'end',
      turnId: 't1',
      text: 'hello <- asked',
    });
  });

  it('reports a runtime failure as an error frame', async () => {
    start({
      resumes: false,
      async run() {
        throw new Error('codex exited with 2');
      },
    });
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'x', history: [] }));
    await until(() => received.some((f) => f.type === 'error'));
    expect(received.find((f) => f.type === 'error')).toMatchObject({
      turnId: 't1',
      message: 'codex exited with 2',
    });
  });

  it('runs turns one at a time', async () => {
    let running = 0;
    let peak = 0;
    start({
      resumes: false,
      async run() {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 40));
        running--;
        return 'ok';
      },
    });
    await until(() => peers.length > 0 && received.length > 0);
    for (const id of ['a', 'b', 'c']) {
      peers[0].send(JSON.stringify({ type: 'turn', turnId: id, task: 'x', history: [] }));
    }
    await until(() => received.filter((f) => f.type === 'end').length === 3);
    expect(peak).toBe(1);
  });

  it('aborts a running turn on cancel and sends nothing for it', async () => {
    let aborted = false;
    start({
      resumes: false,
      run: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('Cancelled'));
          });
        }),
    });
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'x', history: [] }));
    await new Promise((r) => setTimeout(r, 50));
    peers[0].send(JSON.stringify({ type: 'cancel', turnId: 't1' }));
    await until(() => aborted);
    await new Promise((r) => setTimeout(r, 50));
    expect(received.some((f) => f.type === 'error' || f.type === 'end')).toBe(false);
  });

  it('reconnects after the server drops it', async () => {
    start(echo);
    await until(() => peers.length === 1 && received.length === 1);
    peers[0].terminate();
    await until(() => peers.length === 2 && received.filter((f) => f.type === 'auth').length === 2);
  });

  it('exits and forgets when the agent is revoked', async () => {
    const d = start(echo);
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'revoked' }));
    await expect(d.done).resolves.toEqual({ reason: 'revoked' });
  });

  it('exits without retrying when its credential was replaced by a newer one', async () => {
    wss.removeAllListeners('connection');
    let attempts = 0;
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        attempts += 1;
        ws.send(JSON.stringify({ type: 'auth-error', reason: 'invalid_credential' }));
        ws.close();
      });
    });
    const d = start(echo);
    await expect(d.done).resolves.toEqual({ reason: 'credential-rejected' });
    await new Promise((r) => setTimeout(r, 80));
    expect(attempts).toBe(1);
  });

  it('hands every run the gemie’s tools when Gemies serves them', async () => {
    const seen: RuntimeRun[] = [];
    start(
      {
        resumes: false,
        async run(input) {
          seen.push(input);
          return 'done';
        },
      },
      { toolsUrl: 'https://api.gemies.ai/mcp/agents/agent-1' },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'x', history: [] }));
    await until(() => seen.length === 1);
    expect(seen[0].tools).toEqual({
      url: 'https://api.gemies.ai/mcp/agents/agent-1',
      credential: 'gxa_agent-1',
    });
  });

  it('names the person’s chat to the tools on a turn of it, so the agent can write to gemies', async () => {
    const seen: RuntimeRun[] = [];
    start(
      {
        resumes: false,
        async run(input) {
          seen.push(input);
          return 'done';
        },
      },
      { toolsUrl: 'https://api.gemies.ai/mcp/agents/agent-1' },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(
      JSON.stringify({ type: 'turn', turnId: 't1', task: 'x', history: [], threadKey: 'chat-1' }),
    );
    await until(() => seen.length === 1);
    expect(seen[0].tools).toEqual({
      url: 'https://api.gemies.ai/mcp/agents/agent-1',
      credential: 'gxa_agent-1',
      conversationId: 'chat-1',
    });
  });

  it('exits when Gemies says the agent is unknown', async () => {
    wss.removeAllListeners('connection');
    wss.on('connection', (ws) => {
      ws.on('message', () =>
        ws.send(JSON.stringify({ type: 'auth-error', reason: 'unknown_agent' })),
      );
    });
    const d = start(echo);
    await expect(d.done).resolves.toEqual({ reason: 'unknown-agent' });
  });

  it('keeps retrying while Gemies cannot be reached, and never gives up on that', async () => {
    const port = (wss.address() as { port: number }).port;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    let exited = false;
    const d = start(echo, { maxAuthFailures: 2, minBackoffMs: 5, maxBackoffMs: 10 });
    void d.done.then(() => {
      exited = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(exited).toBe(false);
    // Gemies comes back on the same address: the daemon connects without being restarted.
    // The port was just released: a busy machine may keep it a moment, so binding is retried.
    for (let attempt = 0; ; attempt++) {
      try {
        wss = await new Promise<WebSocketServer>((resolve, reject) => {
          const server = new WebSocketServer({ port, host: '127.0.0.1' });
          server.once('listening', () => resolve(server));
          server.once('error', reject);
        });
        break;
      } catch (err) {
        if (attempt >= 50) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    wss.on('connection', (ws) => {
      peers.push(ws);
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame.type === 'auth')
          ws.send(JSON.stringify({ type: 'auth-ok', agentId: frame.agentId }));
      });
    });
    await until(() => received.some((f) => f.type === 'auth'), 15_000);
  }, 30_000);

  it('gives up after repeated refused handshakes', async () => {
    wss.removeAllListeners('connection');
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(JSON.stringify({ type: 'auth-error', reason: 'server_error' }));
        ws.close();
      });
    });
    const d = start(echo, { maxAuthFailures: 3 });
    await expect(d.done).resolves.toEqual({ reason: 'auth-failed' });
  });
});

function memorySessions(): SessionStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (key) => map.get(key),
    set: (key, id) => void map.set(key, id),
    delete: (key) => void map.delete(key),
  };
}

describe('session resume', () => {
  const turn = (turnId: string, threadKey?: string) =>
    JSON.stringify({
      type: 'turn',
      turnId,
      task: 'next',
      history: [{ role: 'user', content: 'earlier' }],
      ...(threadKey ? { threadKey } : {}),
    });

  it('stores the CLI session of a conversation and resumes it, sending only the new message', async () => {
    const sessions = memorySessions();
    const seen: { resumeId?: string; prompt: string }[] = [];
    start(
      {
        resumes: true,
        async run({ prompt, resumeId, onSession }) {
          seen.push({ prompt, ...(resumeId ? { resumeId } : {}) });
          onSession?.('sess-1');
          return 'ok';
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('t1', 'conv-1'));
    await until(() => received.filter((f) => f.type === 'end').length === 1);
    peers[0].send(turn('t2', 'conv-1'));
    await until(() => received.filter((f) => f.type === 'end').length === 2);

    expect(sessions.map.get('agent-1:conv-1')).toBe('sess-1');
    expect(seen[0].resumeId).toBeUndefined();
    expect(seen[0].prompt).toContain('[person] earlier');
    expect(seen[1].resumeId).toBe('sess-1');
    expect(seen[1].prompt).not.toContain('earlier');
    expect(seen[1].prompt).toContain('next');
  });

  it('keeps conversations apart and does nothing without a thread key or for a CLI that cannot resume', async () => {
    const sessions = memorySessions();
    const resumeIds: (string | undefined)[] = [];
    start(
      {
        resumes: true,
        async run({ resumeId, onSession }) {
          resumeIds.push(resumeId);
          onSession?.(`s-${resumeIds.length}`);
          return 'ok';
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('a', 'conv-a'));
    peers[0].send(turn('b', 'conv-b'));
    peers[0].send(turn('c'));
    await until(() => received.filter((f) => f.type === 'end').length === 3);
    expect(resumeIds).toEqual([undefined, undefined, undefined]);
    expect([...sessions.map.keys()]).toEqual(['agent-1:conv-a', 'agent-1:conv-b']);
  });

  it('starts over with the full conversation when the CLI lost the session', async () => {
    const sessions = memorySessions();
    sessions.map.set('agent-1:conv-1', 'gone');
    const prompts: string[] = [];
    start(
      {
        resumes: true,
        async run({ prompt, resumeId, onSession }) {
          prompts.push(prompt);
          if (resumeId === 'gone') throw new Error('No conversation found with session ID: gone');
          onSession?.('fresh');
          return 'recovered';
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('t1', 'conv-1'));
    await until(() => received.some((f) => f.type === 'end'));
    expect(received.find((f) => f.type === 'end')).toMatchObject({ text: 'recovered' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('[person] earlier');
    expect(sessions.map.get('agent-1:conv-1')).toBe('fresh');
  });

  it('does not retry a resumed turn that already streamed text', async () => {
    const sessions = memorySessions();
    sessions.map.set('agent-1:conv-1', 'sess');
    let calls = 0;
    start(
      {
        resumes: true,
        async run({ onDelta }) {
          calls++;
          onDelta('partial');
          throw new Error('crashed midway');
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('t1', 'conv-1'));
    await until(() => received.some((f) => f.type === 'error'));
    expect(calls).toBe(1);
  });
});

describe('framePrompt', () => {
  it('names the agent, marks the conversation as untrusted and ends with the new message', () => {
    const prompt = framePrompt({
      agentName: 'Codex · laptop',
      task: 'fix the bug',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    expect(prompt).toContain('You are "Codex · laptop"');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('[person] hi');
    expect(prompt).toContain('[Codex · laptop] hello');
    expect(prompt.trimEnd().endsWith('fix the bug')).toBe(true);
  });

  it('tells a read-only agent how to lift the restriction, and a writable one nothing of the sort', () => {
    const base = { agentName: 'A', task: 'edit it', history: [] };
    expect(framePrompt({ ...base, write: false })).toContain('READ-ONLY');
    expect(framePrompt({ ...base, write: false })).toContain('--read-only');
    expect(framePrompt({ ...base, write: true })).not.toContain('READ-ONLY');
    expect(framePrompt(base)).not.toContain('READ-ONLY');
  });

  it('sends only the message to a resumed session, plus the read-only note when it applies', () => {
    expect(framePrompt({ agentName: 'A', task: 'go', history: [], resumed: true })).toBe('go');
    expect(
      framePrompt({ agentName: 'A', task: 'go', history: [], resumed: true, write: false }),
    ).toContain('--read-only');
  });

  it('drops the oldest turns of a very long conversation, never the new message', () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      role: 'user' as const,
      content: `${i} ${'x'.repeat(1000)}`,
    }));
    const prompt = framePrompt({ agentName: 'A', task: 'now', history });
    expect(prompt.length).toBeLessThan(60_000);
    expect(prompt).toContain('199 xxx');
    expect(prompt).not.toContain('\n0 xxx');
    expect(prompt.trimEnd().endsWith('now')).toBe(true);
  });
});

describe('runProcess', () => {
  it('runs without a shell, feeds stdin and captures output', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'process.stdin.on("data",d=>process.stdout.write("got:"+d))'],
      cwd: '/tmp',
      stdin: 'a b; echo pwned',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ code: 0, stdout: 'got:a b; echo pwned' });
  });

  it('kills the process on abort', async () => {
    const controller = new AbortController();
    const run = runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},60000)'],
      cwd: '/tmp',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toThrow('Cancelled');
  });

  it('says so when the CLI is not installed', async () => {
    await expect(
      runProcess({
        command: 'definitely-not-a-real-cli',
        args: [],
        cwd: '/tmp',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('is not installed');
  });
});

describe('daemon: the folder of a session (Gemies ADR 0043)', () => {
  let base: string;
  let paired: string;
  let other: string;
  let outside: string;
  const ran: string[] = [];
  const cwdRuntime: ExternalRuntime = {
    resumes: false,
    async run({ cwd }: RuntimeRun) {
      ran.push(cwd);
      return 'done';
    },
  };

  beforeEach(() => {
    ran.length = 0;
    base = realpathSync(mkdtempSync(join(tmpdir(), 'gemies-daemon-')));
    paired = join(base, 'paired');
    other = join(base, 'other');
    outside = join(base, 'outside');
    for (const dir of [paired, join(paired, 'sub'), other, outside])
      mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const ask = async (turnId: string, cwd?: string) => {
    peers[0].send(
      JSON.stringify({ type: 'turn', turnId, task: 'x', history: [], ...(cwd ? { cwd } : {}) }),
    );
  };

  it('runs a turn without a folder where the agent was paired, and one inside it where it names', async () => {
    start(cwdRuntime, { cwd: paired });
    await until(() => peers.length > 0 && received.length > 0);
    await ask('t1');
    await until(() => received.some((f) => f.type === 'end' && f.turnId === 't1'));
    await ask('t2', join(paired, 'sub'));
    await until(() => received.some((f) => f.type === 'end' && f.turnId === 't2'));
    expect(ran).toEqual([paired, join(paired, 'sub')]);
  });

  it('refuses a folder outside what this computer allows, without running the CLI', async () => {
    start(cwdRuntime, { cwd: paired });
    await until(() => peers.length > 0 && received.length > 0);
    await ask('t1', outside);
    await until(() => received.some((f) => f.type === 'error'));
    expect(received.find((f) => f.type === 'error')).toMatchObject({
      turnId: 't1',
      message: expect.stringContaining('gemies allow'),
    });
    expect(ran).toEqual([]);
  });

  it('honours a root allowed later, with no restart', async () => {
    const roots: string[] = [];
    start(cwdRuntime, { cwd: paired, allowedRoots: () => roots });
    await until(() => peers.length > 0 && received.length > 0);
    await ask('t1', other);
    await until(() => received.some((f) => f.type === 'error'));
    roots.push(other);
    await ask('t2', other);
    await until(() => received.some((f) => f.type === 'end' && f.turnId === 't2'));
    expect(ran).toEqual([other]);
  });

  it('runs sessions of different folders together, and one folder one turn at a time', async () => {
    let running = 0;
    let peak = 0;
    const byFolder: Record<string, number> = {};
    start(
      {
        resumes: false,
        async run({ cwd }: RuntimeRun) {
          running += 1;
          byFolder[cwd] = (byFolder[cwd] ?? 0) + 1;
          peak = Math.max(peak, running);
          const sameFolderAtOnce = byFolder[cwd];
          await new Promise((r) => setTimeout(r, 60));
          running -= 1;
          byFolder[cwd] -= 1;
          if (sameFolderAtOnce > 1) throw new Error('two turns in one folder at once');
          return 'done';
        },
      },
      { cwd: paired, allowedRoots: () => [other] },
    );
    await until(() => peers.length > 0 && received.length > 0);
    await ask('a1', paired);
    await ask('a2', paired);
    await ask('b1', other);
    await until(() => received.filter((f) => f.type === 'end' || f.type === 'error').length === 3);
    expect(received.filter((f) => f.type === 'error')).toEqual([]);
    expect(peak).toBe(2);
  });
});

describe('daemon: sessions begun in a terminal (Gemies ADR 0043 §4)', () => {
  const seenResume: (string | undefined)[] = [];
  const resuming: ExternalRuntime = {
    resumes: true,
    async run({ resumeId, onSession }: RuntimeRun) {
      seenResume.push(resumeId);
      onSession?.('next-session-id');
      return 'done';
    },
  };
  const turn = (turnId: string, extra: Record<string, unknown>) =>
    peers[0].send(
      JSON.stringify({ type: 'turn', turnId, task: 'x', history: [], threadKey: 'c-1', ...extra }),
    );

  beforeEach(() => {
    seenResume.length = 0;
  });

  it('continues the terminal session a conversation was opened on, once, then its own', async () => {
    const sessions = memorySessions();
    start(resuming, { sessions });
    await until(() => peers.length > 0 && received.length > 0);
    turn('t1', { resumeId: 'terminal-session-1' });
    await until(() => received.some((f) => f.type === 'end' && f.turnId === 't1'));
    turn('t2', { resumeId: 'terminal-session-1' });
    await until(() => received.some((f) => f.type === 'end' && f.turnId === 't2'));
    // The CLI's own session of the first turn wins from then on.
    expect(seenResume).toEqual(['terminal-session-1', 'next-session-id']);
  });

  it('ignores an id that is not a session id', async () => {
    start(resuming, { sessions: memorySessions() });
    await until(() => peers.length > 0 && received.length > 0);
    turn('t1', { resumeId: '--dangerous; rm -rf /' });
    await until(() => received.some((f) => f.type === 'end'));
    expect(seenResume).toEqual([undefined]);
  });

  it('answers a request for the sessions here with the request’s id', async () => {
    start(echo, { cli: 'opencode' });
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'list-sessions', requestId: 'r-1' }));
    await until(() => received.some((f) => f.type === 'sessions'));
    expect(received.find((f) => f.type === 'sessions')).toEqual({
      type: 'sessions',
      requestId: 'r-1',
      sessions: [],
    });
  });
});

describe('daemon: activity (Gemies ADR 0043 §5)', () => {
  it('forwards what the CLI reports it is doing, tagged with the turn, before the answer', async () => {
    start({
      resumes: false,
      async run({ onActivity, onDelta }: RuntimeRun) {
        onActivity?.({ id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'running' });
        onActivity?.({ id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'done' });
        onDelta('ok');
        return 'ok';
      },
    });
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'x', history: [] }));
    await until(() => received.some((f) => f.type === 'end'));
    expect(received.filter((f) => f.type === 'activity')).toEqual([
      {
        type: 'activity',
        turnId: 't1',
        activity: { id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'running' },
      },
      {
        type: 'activity',
        turnId: 't1',
        activity: { id: 'a', tool: 'Read', summary: '/w/a.txt', status: 'done' },
      },
    ]);
    const kinds = received.map((f) => f.type);
    expect(kinds.indexOf('activity')).toBeLessThan(kinds.indexOf('end'));
  });
});

describe('daemon: permission questions answered in Gemies (ADR 0043 §5)', () => {
  /** A CLI that asks for permission the way Claude Code does, and ends with what it was told. */
  const asking: ExternalRuntime = {
    resumes: false,
    approvals: true,
    async run({ approvals }: RuntimeRun) {
      if (!approvals) return 'no-approvals';
      const response = await fetch(approvals.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${approvals.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'approve',
            arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu_1' },
          },
        }),
      });
      const body = (await response.json()) as { result: { content: { text: string }[] } };
      return (JSON.parse(body.result.content[0].text) as { behavior: string }).behavior;
    },
  };

  function serverWith(features: string[] | undefined) {
    wss.removeAllListeners('connection');
    wss.on('connection', (ws) => {
      peers.push(ws);
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame.type === 'auth') {
          ws.send(
            JSON.stringify({
              type: 'auth-ok',
              agentId: frame.agentId,
              ...(features ? { features } : {}),
            }),
          );
        }
      });
    });
  }

  const turn = (turnId = 't1') =>
    peers[0].send(JSON.stringify({ type: 'turn', turnId, task: 'x', history: [] }));
  const ready = () => until(() => peers.length > 0 && received.some((f) => f.type === 'auth'));
  const ended = () => received.find((f) => f.type === 'end') as { text: string } | undefined;

  it('asks Gemies, names the tool and what it acts on, and lets the CLI go on when allowed', async () => {
    serverWith(['approvals']);
    start(asking, { write: true });
    await ready();
    await until(() => received.length > 0);
    // `auth-ok` arrives after the daemon sent `auth`; wait for it to be processed.
    await new Promise((r) => setTimeout(r, 50));
    turn();
    await until(() => received.some((f) => f.type === 'approval-request'));
    const request = received.find((f) => f.type === 'approval-request') as Record<string, string>;
    expect(request).toMatchObject({ turnId: 't1', tool: 'Bash', summary: 'ls' });
    expect(Date.parse(request.expiresAt)).toBeGreaterThan(Date.now());
    peers[0].send(
      JSON.stringify({ type: 'approval', requestId: request.requestId, decision: 'allow' }),
    );
    await until(() => ended() !== undefined);
    expect(ended()?.text).toBe('allow');
  });

  it('tells the CLI no when the person says no', async () => {
    serverWith(['approvals']);
    start(asking, { write: true });
    await ready();
    await new Promise((r) => setTimeout(r, 50));
    turn();
    await until(() => received.some((f) => f.type === 'approval-request'));
    const request = received.find((f) => f.type === 'approval-request') as { requestId: string };
    peers[0].send(
      JSON.stringify({ type: 'approval', requestId: request.requestId, decision: 'deny' }),
    );
    await until(() => ended() !== undefined);
    expect(ended()?.text).toBe('deny');
  });

  it('denies a question nobody answers in time, and ignores an answer to one it never asked', async () => {
    serverWith(['approvals']);
    start(asking, { write: true, approvalTimeoutMs: 150 });
    await ready();
    await new Promise((r) => setTimeout(r, 50));
    peers[0].send(
      JSON.stringify({ type: 'approval', requestId: 'never-asked', decision: 'allow' }),
    );
    turn();
    await until(() => ended() !== undefined);
    expect(ended()?.text).toBe('deny');
    expect(received.find((f) => f.type === 'approval-resolved')).toMatchObject({
      turnId: 't1',
      decision: 'expired',
    });
  });

  it('denies what is waiting when the connection drops', async () => {
    serverWith(['approvals']);
    let result: string | undefined;
    start(
      {
        ...asking,
        async run(input: RuntimeRun) {
          result = await asking.run(input);
          return result;
        },
      },
      { write: true },
    );
    await ready();
    await new Promise((r) => setTimeout(r, 50));
    turn();
    await until(() => received.some((f) => f.type === 'approval-request'));
    peers[0].terminate();
    await until(() => result !== undefined);
    expect(result).toBe('deny');
  });

  it('offers no way to ask when Gemies cannot carry the question, or the agent is read-only', async () => {
    serverWith(undefined);
    start(asking, { write: true });
    await ready();
    await new Promise((r) => setTimeout(r, 50));
    turn();
    await until(() => ended() !== undefined);
    expect(ended()?.text).toBe('no-approvals');
    expect(received.some((f) => f.type === 'approval-request')).toBe(false);

    daemon?.stop();
    received = [];
    peers = [];
    serverWith(['approvals']);
    start(asking, { write: false });
    await ready();
    await new Promise((r) => setTimeout(r, 50));
    turn('t2');
    await until(() => ended() !== undefined);
    expect(ended()?.text).toBe('no-approvals');
  });
});
