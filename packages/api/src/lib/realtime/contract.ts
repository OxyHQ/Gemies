/**
 * The realtime wire contract (`docs/realtime.mdx`): what travels on the one Socket.IO connection a
 * signed-in client holds. `@gemies/sdk`'s `realtime/contract.ts` is the client's copy of these
 * names; `realtime-contract.test.ts` holds the two to the same list.
 *
 * Server → client is ONE event, `rt`, carrying a {@link RealtimeFrame}. A frame with `seq` is
 * durable: it is in the account's log (`account_events`) and a client that missed it gets it again
 * from `rt:sync`. A frame without `seq` is a signal — typing, presence, progress, a room's
 * streaming — that is only true while it is happening and is never replayed.
 */

import type { AccountEventType } from '../../domain/account-events.js';

/** The one server → client event name. */
export const REALTIME_EVENT = 'rt';
/** Client → server: catch up from a cursor (ack: {@link RealtimeSyncReply}). */
export const REALTIME_SYNC = 'rt:sync';
/** Client → server: follow a topic beyond the account's own events (ack: `{ ok }`). */
export const REALTIME_SUBSCRIBE = 'rt:subscribe';
/** Client → server: stop following a topic. */
export const REALTIME_UNSUBSCRIBE = 'rt:unsubscribe';

/** The signals: never logged, never replayed. */
export const REALTIME_SIGNAL_TYPES = [
  /** What an actor is doing in a conversation: thinking, writing, using a tool, or done. */
  'activity',
  /** A group room's live frames (`alia.agent_*`, `group.message`, `group.idle`; ADR 0025). */
  'room',
  /** An external agent came online or went offline. */
  'presence',
  /** A device offering its own inference runtime joined or left. */
  'runtimes',
  /** A show episode's generation progress. */
  'show.progress',
  /** An agent run's detailed activity, on its topic (`agent:<id>`, `agent-session:<id>`). */
  'agent.activity',
] as const;

export type RealtimeSignalType = (typeof REALTIME_SIGNAL_TYPES)[number];
export type RealtimeType = AccountEventType | RealtimeSignalType;

export interface RealtimeFrame {
  readonly v: 1;
  readonly type: RealtimeType;
  readonly data: unknown;
  /** The account log's number: present on durable events only. */
  readonly seq?: number;
  /** The topic a topic-scoped signal belongs to (`agent:<id>`, `agent-session:<id>`). */
  readonly topic?: string;
}

/** `rt:sync`'s answer: the events after the client's cursor, or `reset` when it must reload. */
export interface RealtimeSyncReply {
  /** The account's newest event number: the client's cursor after applying `events`. */
  readonly head: number;
  readonly events?: readonly RealtimeFrame[];
  /** The log no longer reaches back to the cursor: reload what is shown, then carry on from `head`. */
  readonly reset?: true;
}

/** What an actor is doing, as a person's surfaces show it: WhatsApp's "typing…", and more. */
export const ACTIVITY_STATES = ['thinking', 'writing', 'tool', 'idle'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/**
 * How often a running actor repeats its state, and how long a client keeps one it has not heard
 * repeated. A crashed run never says `idle`; a client that reconnects mid-turn hears it again
 * within one interval.
 */
export const ACTIVITY_HEARTBEAT_MS = 10_000;
export const ACTIVITY_TTL_MS = 30_000;

export interface ActivitySignal {
  /** The conversation it happens in; `null` for an agent run that has none. */
  readonly conversationId: string | null;
  /** The agent session, for a run (`alia-task`, a gemie's own work). */
  readonly sessionId?: string;
  /** Who: a gemie by its public id (`publicAgentId`), with its name when known. */
  readonly actor: { readonly agentId: string | null; readonly name?: string | null };
  readonly state: ActivityState;
  /** The tool being used, while `state` is `tool`. */
  readonly tool?: string;
  /** How long to believe this without hearing it again. */
  readonly ttlMs: number;
}
