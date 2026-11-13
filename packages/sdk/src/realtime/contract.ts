/**
 * The realtime wire contract, as clients read it (`docs/realtime.mdx`). The API's
 * `lib/realtime/contract.ts` and `domain/account-events.ts` are the server's copy;
 * `packages/api/src/__tests__/realtime-contract.test.ts` holds the two lists equal.
 *
 * Pure data: no React, no socket, so a test on either side can import it.
 */

import type { Message } from '../runtime/types';

/** The one server → client event. */
export const REALTIME_EVENT = 'rt';
/** Client → server: catch up from a cursor. */
export const REALTIME_SYNC = 'rt:sync';
/** Client → server: follow a topic (`agent:<id>`, `agent-session:<id>`). */
export const REALTIME_SUBSCRIBE = 'rt:subscribe';
/** Client → server: stop following a topic. */
export const REALTIME_UNSUBSCRIBE = 'rt:unsubscribe';

/** Durable: numbered per account, replayed to a client that reconnects. */
export const REALTIME_DURABLE_TYPES = [
  'conversation',
  'conversation.deleted',
  'message.reaction',
  'gemies',
  'credits',
  'notification',
  'connections',
  'collections',
] as const;

/** Signals: only true while they happen, never replayed. */
export const REALTIME_SIGNAL_TYPES = [
  'activity',
  'room',
  'presence',
  'runtimes',
  'show.progress',
  'agent.activity',
] as const;

export type RealtimeDurableType = (typeof REALTIME_DURABLE_TYPES)[number];
export type RealtimeSignalType = (typeof REALTIME_SIGNAL_TYPES)[number];
export type RealtimeType = RealtimeDurableType | RealtimeSignalType;

export interface RealtimeFrame<T extends RealtimeType = RealtimeType> {
  readonly v: 1;
  readonly type: T;
  readonly data: RealtimeData[T];
  readonly seq?: number;
  readonly topic?: string;
}

export interface RealtimeSyncReply {
  readonly head: number;
  readonly events?: readonly RealtimeFrame[];
  readonly reset?: true;
}

/** A conversation as a list shows it (the API's `ConversationSummary`), dates as ISO strings. */
export interface RealtimeConversationRow {
  readonly id: string;
  readonly title: string;
  readonly lastMessage: string | null;
  readonly source: string;
  readonly agentId: string | null;
  readonly threadId: string | null;
  readonly memberAgentIds: string[];
  readonly spaceId: string | null;
  readonly app: string | null;
  readonly unreadCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A gemie's whole thread with the person (many conversations): its sidebar row's badge. */
export interface RealtimeThreadTotal {
  readonly agentId: string | null;
  readonly unreadCount: number;
}

export type ActivityState = 'thinking' | 'writing' | 'tool' | 'idle';

export interface RealtimeActivity {
  readonly conversationId: string | null;
  readonly sessionId?: string;
  readonly actor: { readonly agentId: string | null; readonly name?: string | null };
  readonly state: ActivityState;
  readonly tool?: string;
  readonly ttlMs: number;
}

/** A person's folders, projects, pins and favourites, as the API answers and publishes them. */
export interface CollectionsSnapshotWire {
  readonly collections: ReadonlyArray<{
    readonly id: string;
    readonly kind: 'folder' | 'project';
    readonly name: string;
    readonly description: string | null;
    readonly icon: string | null;
    readonly color: string | null;
    readonly isFavorite: boolean;
    readonly isExpanded: boolean;
    readonly conversationIds: string[];
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
  readonly pinned: string[];
  readonly favorites: string[];
}

export interface RealtimeData {
  conversation: {
    readonly conversation: RealtimeConversationRow;
    readonly thread: RealtimeThreadTotal;
    /** Messages the conversation gained, as `GET /conversations/:id` returns them. */
    readonly appended?: Message[];
    /** The thread was rewritten: read it again. */
    readonly reload?: true;
  };
  'conversation.deleted': {
    readonly conversationId: string;
    readonly thread?: RealtimeThreadTotal;
  };
  'message.reaction': {
    readonly conversationId: string;
    readonly messageId: string;
    readonly reactions: readonly string[];
    readonly revision: number;
    readonly mutationId: string;
  };
  gemies: { readonly agentId: string | null; readonly change: 'created' | 'updated' | 'deleted' };
  credits: { readonly credits?: number };
  notification: { readonly notification: Record<string, unknown> & { readonly id: string } };
  connections: Record<string, never>;
  collections: CollectionsSnapshotWire;
  activity: RealtimeActivity;
  room: {
    readonly conversationId: string;
    readonly chainId: string;
    readonly event: string;
    readonly data: unknown;
  };
  presence: { readonly agentId: string; readonly online: boolean };
  runtimes: Record<string, never>;
  'show.progress': Record<string, unknown> & { readonly episodeId: string };
  'agent.activity': Record<string, unknown> & {
    readonly sessionId: string;
    readonly agentId: string;
  };
}

const TYPES: ReadonlySet<string> = new Set<string>([
  ...REALTIME_DURABLE_TYPES,
  ...REALTIME_SIGNAL_TYPES,
]);

/** A frame this client understands, or `null`: an unknown type from a newer server is skipped. */
export function readFrame(value: unknown): RealtimeFrame | null {
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Partial<RealtimeFrame>;
  if (frame.v !== 1 || typeof frame.type !== 'string' || !TYPES.has(frame.type)) return null;
  if (
    frame.seq !== undefined &&
    (typeof frame.seq !== 'number' || !Number.isSafeInteger(frame.seq))
  )
    return null;
  return frame as RealtimeFrame;
}
