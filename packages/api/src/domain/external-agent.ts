/**
 * Closed value sets and wire protocol for external agents (ADR 0030).
 *
 * A leaf module: the drizzle schema renders its CHECK from {@link EXTERNAL_AGENT_CLIS}, and the
 * daemon (`@alia-codea/cli`) mirrors the frame shapes below by hand, so keep them boring.
 */

/** The coding-agent CLIs a daemon can drive. */
export const EXTERNAL_AGENT_CLIS = ['claude', 'codex', 'opencode'] as const;
export type ExternalAgentCli = (typeof EXTERNAL_AGENT_CLIS)[number];

export const EXTERNAL_AGENT_CLI_LABELS: Record<ExternalAgentCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * The colour a paired agent starts with, by its CLI (a Bloom preset key, as an account's colour
 * is); its owner may change it in the editor. Migration 0149 gave the existing ones the same.
 */
export const EXTERNAL_AGENT_CLI_COLORS: Record<ExternalAgentCli, string> = {
  claude: 'orange',
  codex: 'graphite',
  opencode: 'teal',
};

/** One earlier message of the conversation a turn answers. */
export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** How many earlier messages a direct chat turn carries to the daemon. */
export const EXTERNAL_HISTORY_TURNS = 20;

/** How long a pairing code can be redeemed. */
export const EXTERNAL_PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Pairing codes are `XXXX-XXXX-XXXX-XXXX` over an alphabet without look-alikes (no 0/O, 1/I/L): 16
 * symbols over 31, ~79 bits. The code alone authorises its redemption, from anywhere, so it is long
 * enough that guessing one of the few live codes is hopeless even before the rate limit.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_GROUPS = 4;
export const PAIRING_CODE_GROUP_LENGTH = 4;

/** An external agent that does not answer within this long has failed its turn. */
export const EXTERNAL_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** Frames the server sends to the daemon. */
export type ServerFrame =
  | { type: 'auth-ok'; agentId: string }
  | { type: 'auth-error'; reason: string }
  | {
      type: 'turn';
      turnId: string;
      /** What to answer: the latest message, framed for the agent. */
      task: string;
      /**
       * Names the conversation this turn belongs to (a conversation id), so the daemon can resume
       * the CLI's own session for it. Absent for turns that are not part of one (a consultation).
       */
      threadKey?: string;
      history: readonly ChatTurn[];
    }
  | { type: 'cancel'; turnId: string }
  | { type: 'revoked' };

/**
 * Frames the daemon sends to the server. `auth` presents the agent's own credential, which redeeming
 * its pairing code returned (ADR 0038); nothing of the person's Oxy session reaches the relay.
 *
 * `token` is the retired form (Codea 3.x): the person's Oxy session. The relay still takes it for a
 * link paired before credentials existed, and for nothing else, until production holds none.
 */
export type DaemonFrame =
  | { type: 'auth'; agentId: string; credential?: string; token?: string }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'end'; turnId: string; text?: string }
  | { type: 'error'; turnId: string; message: string };
