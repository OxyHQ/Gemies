/**
 * What a person's account log records (`account_events`, `docs/realtime.mdx`).
 *
 * The DURABLE half of the realtime contract: a change a client must not miss, so it is numbered
 * per account and replayed to a client that reconnects. Ephemeral signals (typing, presence,
 * progress, a room's streaming frames) are never logged: a missed one is simply over.
 *
 * The CHECK on `account_events.type` and the API's publisher read this tuple; the SDK's
 * `realtime/contract.ts` spells the same names for clients.
 */
export const ACCOUNT_EVENT_TYPES = [
  /** A conversation was created or changed (its sidebar row), with any messages it gained. */
  'conversation',
  /** A conversation is gone. */
  'conversation.deleted',
  /** A message's reactions changed. */
  'message.reaction',
  /** The person's gemies changed: one was made, edited, deleted, or its look changed. */
  'gemies',
  /** The account's credit balance moved. */
  'credits',
  /** A notification was created. */
  'notification',
  /** Connected accounts or connectors changed (linked, unlinked, status). */
  'connections',
  /** How the person files conversations changed: folders, projects, pins, favourites (a snapshot). */
  'collections',
] as const;

export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

/**
 * How long a reconnecting client can catch up from its cursor. A client away for longer is told to
 * reload what it shows (`reset`), once: three days covers a laptop closed over a weekend.
 */
export const ACCOUNT_EVENT_RETENTION_SECONDS = 3 * 24 * 60 * 60;

/** The most events one catch-up replays; a client further behind reloads instead. */
export const ACCOUNT_EVENT_REPLAY_LIMIT = 500;
