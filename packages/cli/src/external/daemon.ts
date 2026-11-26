import { framePrompt } from './prompt.js';
import { resolveSessionCwd } from './roots.js';
import { listTerminalSessions, SESSION_ID } from './terminal-sessions.js';
import type { SessionStore } from './state.js';
import type { DaemonFrame, ExternalCli, ExternalRuntime, ServerFrame } from './types.js';

export interface DaemonOptions {
  readonly wsUrl: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly runtime: ExternalRuntime;
  /** Which CLI this agent serves; lets it list that CLI's sessions begun in a terminal (ADR 0043). */
  readonly cli?: ExternalCli;
  readonly cwd: string;
  readonly write: boolean;
  /**
   * The agent's own credential, which redeeming its pairing code returned. It opens this agent's
   * connection and nothing else, and lasts as long as the agent: no sign-in, no refresh.
   */
  readonly credential: string;
  /** Where Gemies serves this agent's tools (ADR 0039); every run gets them as `gemies`. */
  readonly toolsUrl?: string;
  readonly log?: (message: string) => void;
  /** Reconnect backoff bounds; tests shrink them. */
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** The CLI's own sessions per conversation. Omitted: every turn starts fresh. */
  readonly sessions?: SessionStore;
  /**
   * The folders sessions opened from Gemies may work in, besides `cwd` (Gemies ADR 0043). Read at
   * each turn, so allowing one needs no restart. Omitted: only `cwd` and what is under it.
   */
  readonly allowedRoots?: () => readonly string[];
  /** Consecutive refused handshakes before giving up (a network failure never counts). */
  readonly maxAuthFailures?: number;
}

type DaemonExit =
  | { reason: 'stopped' }
  | { reason: 'revoked' }
  | { reason: 'unknown-agent' }
  /** The agent was reconnected with a newer credential (here or on another machine). */
  | { reason: 'credential-rejected' }
  | { reason: 'auth-failed' };

export interface Daemon {
  /** Resolves when the daemon will not reconnect any more. */
  readonly done: Promise<DaemonExit>;
  stop(): void;
}

/**
 * Holds the WebSocket to Gemies open and answers the turns it receives, one at a time, by driving the
 * person's CLI. Outbound only: nothing listens on this machine.
 */
export function startDaemon(options: DaemonOptions): Daemon {
  const log = options.log ?? (() => undefined);
  const minBackoff = options.minBackoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const maxAuthFailures = options.maxAuthFailures ?? 5;

  let stopped = false;
  let socket: WebSocket | null = null;
  let backoff = minBackoff;
  let authFailures = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  const turns = new Map<string, AbortController>();
  /** One turn at a time per folder: two CLI runs in one directory would trample each other. */
  const queues = new Map<string, Promise<void>>();

  let finish!: (exit: DaemonExit) => void;
  const done = new Promise<DaemonExit>((resolve) => {
    finish = resolve;
  });

  const exit = (reason: DaemonExit) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    for (const controller of turns.values()) controller.abort();
    socket?.close();
    finish(reason);
  };

  const send = (ws: WebSocket, frame: DaemonFrame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  /** Where a turn runs: the folder its session names if this computer allows it, else the paired one. */
  const turnCwd = (frame: Extract<ServerFrame, { type: 'turn' }>): string | { message: string } => {
    if (!frame.cwd) return options.cwd;
    const resolved = resolveSessionCwd(frame.cwd, [
      options.cwd,
      ...(options.allowedRoots?.() ?? []),
    ]);
    return resolved.ok ? resolved.cwd : { message: resolved.message };
  };

  const runTurn = async (
    ws: WebSocket,
    frame: Extract<ServerFrame, { type: 'turn' }>,
  ): Promise<void> => {
    const controller = new AbortController();
    turns.set(frame.turnId, controller);
    try {
      const cwd = turnCwd(frame);
      if (typeof cwd !== 'string') {
        log(`turn ${frame.turnId.slice(0, 8)}: refused — ${cwd.message}`);
        send(ws, { type: 'error', turnId: frame.turnId, message: cwd.message });
        return;
      }
      log(`turn ${frame.turnId.slice(0, 8)}: started`);
      const sessionKey =
        options.sessions && options.runtime.resumes && frame.threadKey
          ? `${options.agentId}:${frame.threadKey}`
          : undefined;
      let emitted = false;
      const attempt = (resumeId: string | undefined) =>
        options.runtime.run({
          prompt: framePrompt({
            agentName: options.agentName,
            task: frame.task,
            // A resumed session already holds the conversation; a fresh one needs it spelled out.
            history: resumeId ? [] : frame.history,
            write: options.write,
            resumed: resumeId !== undefined,
          }),
          cwd,
          write: options.write,
          signal: controller.signal,
          ...(resumeId ? { resumeId } : {}),
          ...(options.toolsUrl
            ? {
                tools: {
                  url: options.toolsUrl,
                  credential: options.credential,
                  // A turn of the person's chat names it, so the agent can write to their gemies
                  // from there (Gemies ADR 0042); a room or gemie-to-gemie turn names none.
                  ...(frame.threadKey ? { conversationId: frame.threadKey } : {}),
                },
              }
            : {}),
          onSession: (id) => {
            if (sessionKey) options.sessions?.set(sessionKey, id);
          },
          onDelta: (delta) => {
            emitted = true;
            send(ws, { type: 'delta', turnId: frame.turnId, text: delta });
          },
        });
      // The session this conversation kept here; else, once, the terminal session it was opened on.
      const adopted =
        frame.resumeId && SESSION_ID.test(frame.resumeId) ? frame.resumeId : undefined;
      const resumeId = sessionKey ? (options.sessions?.get(sessionKey) ?? adopted) : undefined;
      let text: string;
      try {
        text = await attempt(resumeId);
        if (resumeId && text.trim() === '' && !emitted) throw new Error('empty resumed answer');
      } catch (err: unknown) {
        // The CLI lost that session (cleared, expired): start over with the conversation spelled out.
        if (!resumeId || emitted || controller.signal.aborted) throw err;
        log('could not resume the CLI session; starting a new one');
        if (sessionKey) options.sessions?.delete(sessionKey);
        text = await attempt(undefined);
      }
      if (controller.signal.aborted) return;
      if (text.trim() === '') {
        send(ws, { type: 'error', turnId: frame.turnId, message: 'The agent returned no answer' });
      } else {
        send(ws, { type: 'end', turnId: frame.turnId, text });
      }
      log(`turn ${frame.turnId.slice(0, 8)}: done`);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      log(`turn ${frame.turnId.slice(0, 8)}: failed — ${message}`);
      send(ws, { type: 'error', turnId: frame.turnId, message });
    } finally {
      turns.delete(frame.turnId);
    }
  };

  const connect = (): void => {
    if (stopped) return;
    const ws = new WebSocket(options.wsUrl);
    socket = ws;
    let authenticated = false;
    /** Gemies answered and said no; a socket that never opened (no network yet) is not that. */
    let refused = false;

    ws.onopen = () => {
      send(ws, { type: 'auth', agentId: options.agentId, credential: options.credential });
    };
    ws.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'auth-ok':
          authenticated = true;
          authFailures = 0;
          backoff = minBackoff;
          log('connected');
          break;
        case 'auth-error':
          refused = true;
          log(`Gemies refused the connection: ${frame.reason}`);
          // Neither heals by retrying: the agent is gone, or another credential replaced this one.
          if (frame.reason === 'unknown_agent') exit({ reason: 'unknown-agent' });
          if (frame.reason === 'invalid_credential') exit({ reason: 'credential-rejected' });
          break;
        case 'turn':
          if (!authenticated) return;
          {
            const key = frame.cwd ?? options.cwd;
            const next = (queues.get(key) ?? Promise.resolve()).then(() => runTurn(ws, frame));
            queues.set(key, next);
            void next.then(() => {
              if (queues.get(key) === next) queues.delete(key);
            });
          }
          break;
        case 'list-sessions':
          if (!authenticated) return;
          send(ws, {
            type: 'sessions',
            requestId: frame.requestId,
            sessions: options.cli
              ? listTerminalSessions({
                  cli: options.cli,
                  roots: [options.cwd, ...(options.allowedRoots?.() ?? [])],
                })
              : [],
          });
          break;
        case 'cancel':
          turns.get(frame.turnId)?.abort();
          break;
        case 'revoked':
          log('this agent was removed in Gemies');
          exit({ reason: 'revoked' });
          break;
      }
    };
    let opened = false;
    let gone = false;
    const onGone = () => {
      if (gone) return;
      gone = true;
      if (socket === ws) socket = null;
      for (const controller of turns.values()) controller.abort();
      if (stopped) return;
      log('disconnected');
      // Only a refusal counts toward giving up. An unreachable Gemies (a machine just booted, a
      // network down) is retried for as long as it takes: the daemon is meant to run unattended.
      scheduleReconnect(refused && !authenticated);
    };
    ws.addEventListener('open', () => {
      opened = true;
    });
    ws.onclose = onGone;
    // Node 22 reports a connection that never opened with `error` alone, no `close`; without this
    // the daemon would wait for an event that never comes and never retry.
    ws.onerror = () => {
      if (!opened) onGone();
    };
  };

  function scheduleReconnect(refusedHandshake: boolean): void {
    if (stopped) return;
    if (refusedHandshake) {
      authFailures += 1;
      if (authFailures >= maxAuthFailures) {
        log('giving up: Gemies keeps refusing this connection');
        exit({ reason: 'auth-failed' });
        return;
      }
    }
    const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
    backoff = Math.min(backoff * 2, maxBackoff);
    log(`reconnecting in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return { done, stop: () => exit({ reason: 'stopped' }) };
}
