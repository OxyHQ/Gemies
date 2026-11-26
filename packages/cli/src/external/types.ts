/**
 * The daemon's side of the external-agent protocol (Gemies ADR 0030, ADR 0038). Mirrors
 * OxyHQ/Gemies' `packages/api/src/domain/external-agent.ts`; the two are kept boring on purpose.
 */

import type { GemieTools } from './gemie-tools.js';

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
  | { type: 'auth-ok'; agentId: string }
  | { type: 'auth-error'; reason: string }
  | {
      type: 'turn';
      turnId: string;
      task: string;
      history: readonly ChatTurn[];
      /** The Gemies conversation this turn belongs to, when it belongs to one. */
      threadKey?: string;
    }
  | { type: 'cancel'; turnId: string }
  | { type: 'revoked' };

export type DaemonFrame =
  /** The agent's own credential (Gemies ADR 0038); never an Oxy session. */
  | { type: 'auth'; agentId: string; credential: string }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'end'; turnId: string; text?: string }
  | { type: 'error'; turnId: string; message: string };

export interface RuntimeRun {
  /** The full prompt: framing, history and the new message. */
  readonly prompt: string;
  readonly cwd: string;
  /** Let the agent edit files in `cwd`. On by default; `--read-only` turns it off. */
  readonly write: boolean;
  readonly signal: AbortSignal;
  readonly onDelta: (text: string) => void;
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
  /** Resolves with the agent's full answer. Rejects with a message fit to show the person. */
  run(input: RuntimeRun): Promise<string>;
}
