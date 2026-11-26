/**
 * The daemon's side of the external-agent protocol (Gemies ADR 0030, ADR 0038). Mirrors
 * OxyHQ/Gemies' `packages/api/src/domain/external-agent.ts`; the two are kept boring on purpose.
 */

import type { RunApprovals } from './approval-server.js';
import type { GemieTools } from './gemie-tools.js';
import type { TerminalSession } from './terminal-sessions.js';

export const EXTERNAL_CLIS = ['claude', 'codex', 'opencode'] as const;
export type ExternalCli = (typeof EXTERNAL_CLIS)[number];

export function isExternalCli(value: unknown): value is ExternalCli {
  return typeof value === 'string' && (EXTERNAL_CLIS as readonly string[]).includes(value);
}

export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type ServerFrame =
  | {
      type: 'auth-ok';
      agentId: string;
      /** What this Gemies can do beyond the first protocol; absent on one that predates them. */
      features?: string[];
    }
  | { type: 'auth-error'; reason: string }
  | {
      type: 'turn';
      turnId: string;
      task: string;
      history: readonly ChatTurn[];
      /** The Gemies conversation this turn belongs to, when it belongs to one. */
      threadKey?: string;
      /**
       * The folder a session opened from the app works in (Gemies ADR 0043). Honoured only inside
       * the roots this computer allows; absent, the agent works where it was paired.
       */
      cwd?: string;
      /**
       * The CLI's own id of a session begun in a terminal that this conversation continues (Gemies
       * ADR 0043 §4). Used only when this computer has not yet kept a session for the conversation.
       */
      resumeId?: string;
    }
  /** Asks which sessions the CLI already has here, in the folders this computer allows. */
  | { type: 'list-sessions'; requestId: string }
  | { type: 'cancel'; turnId: string }
  /** The person's answer to an `approval-request` (Gemies ADR 0043 §5). */
  | { type: 'approval'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'revoked' };

export type DaemonFrame =
  /** The agent's own credential (Gemies ADR 0038); never an Oxy session. */
  | { type: 'auth'; agentId: string; credential: string }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'end'; turnId: string; text?: string }
  | { type: 'error'; turnId: string; message: string }
  | { type: 'activity'; turnId: string; activity: ActivityEvent }
  /** The CLI asks permission to use a tool; the turn waits for the person's `approval`. */
  /** The question was answered, or ran out of time: the conversation can close its card. */
  | {
      type: 'approval-resolved';
      turnId: string;
      requestId: string;
      decision: 'allow' | 'deny' | 'expired';
    }
  | {
      type: 'approval-request';
      turnId: string;
      requestId: string;
      tool: string;
      summary?: string;
      expiresAt: string;
    }
  | {
      type: 'sessions';
      requestId: string;
      sessions: readonly TerminalSession[];
      /** The folders this computer allows sessions in: where the agent was paired, and `gemies allow`. */
      roots: readonly string[];
    };

/** One tool a CLI is using (Gemies ADR 0043 §5): never a file's contents or a command's output. */
export interface ActivityEvent {
  /** The CLI's own id for the call: the same id reports it starting and then finishing. */
  readonly id: string;
  readonly tool: string;
  /** What it acts on: a path, a command, a pattern. Short. */
  readonly summary?: string;
  readonly status: 'running' | 'done' | 'error';
}

export interface RuntimeRun {
  /** The full prompt: framing, history and the new message. */
  readonly prompt: string;
  readonly cwd: string;
  /** Let the agent edit files in `cwd`. On by default; `--read-only` turns it off. */
  readonly write: boolean;
  readonly signal: AbortSignal;
  readonly onDelta: (text: string) => void;
  /** Called as the CLI starts and finishes each tool it uses (Gemies ADR 0043 §5). */
  readonly onActivity?: (activity: ActivityEvent) => void;
  /**
   * The local server that asks the person (through Gemies) when the CLI needs permission. Only for a
   * runtime that has `approvals`; without it a request the CLI was not allowed to make is refused.
   */
  readonly approvals?: RunApprovals;
  /**
   * The CLI's own session to continue, when this conversation already has one. The prompt then
   * carries only the new message: the CLI remembers the rest.
   */
  readonly resumeId?: string;
  /** Called with the CLI's session id once it is known, so the next turn can resume it. */
  readonly onSession?: (sessionId: string) => void;
  /** The gemie's tools in Gemies (ADR 0039), as the MCP server `gemies` of this run. */
  readonly tools?: GemieTools;
}

/** One coding-agent CLI, driven non-interactively under the person's own login. */
export interface ExternalRuntime {
  /** Whether this CLI can continue a session by id (`RuntimeRun.resumeId`). */
  readonly resumes: boolean;
  /** Whether this CLI can ask the person for permission through `RuntimeRun.approvals`. */
  readonly approvals?: boolean;
  /** Resolves with the agent's full answer. Rejects with a message fit to show the person. */
  run(input: RuntimeRun): Promise<string>;
}
