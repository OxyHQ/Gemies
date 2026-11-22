/**
 * A person's thread with a gemie, in the signed-in account's store: which stretch is active (the
 * thread itself), everything said before it a page at a time (its history), a stretch of the past
 * opened from a search hit (a window), and the search itself.
 *
 * History and windows are memory only; the thread itself is copied to the account's durable store,
 * so a reopened thread knows its active stretch from the first frame.
 */
import { entity, list, source } from '@oxy.so/bloom-data';
import type { GemieApi } from '../api';
import { errorStatus } from '../error-utils';
import { AGENT_ROUTES, type GemieThreadAddress, threadKey } from '../routes';
import type { ThreadPage, ThreadSearchHit, WireThreadMessage } from '../thread/thread-history';
import { answerSource } from './answer';
import { gemieRead } from './read';

/** A gemie's thread with the signed-in person, as `GET /agents/:id/thread` answers it. */
export interface GemieThreadInfo {
  /** Who the thread is with. `name`, `handle` and `color` come from Oxy and may be `null` (Alia's do, until her account exists). */
  readonly agent: {
    readonly _id: string;
    readonly name: string | null;
    readonly handle: string | null;
    readonly character: unknown;
    readonly tagline: string;
    readonly description: string;
  };
  /** The active stretch: `GemieChatContent`'s `conversationId`, where the next turn goes. */
  readonly conversationId: string;
  /**
   * The thread row, for a gemie whose chats are loose (Alia): her thread is apart from them, and its
   * next stretch is `useCreateConversation().run({ threadId })`. `null` for any other gemie, whose
   * thread is every conversation the two hold.
   */
  readonly threadId: string | null;
}

/** How long a thread read is good; starting a stretch reads it again. */
const THREAD_STALE_MS = 5 * 60_000;
/** How many messages a history page carries. The server clamps its own maximum. */
const PAGE_SIZE = 50;
/** How many messages a window carries, half of them before the hit. */
const WINDOW_SIZE = 40;
/** How many hits a search asks for. */
const HIT_LIMIT = 30;

/** A 404 is the answer (the gemie does not exist or is not the person's): asking again does not change it. */
export function retryThreadRead(failureCount: number, error: unknown): boolean {
  return errorStatus(error) !== 404 && failureCount <= 2;
}

/**
 * The thread: its first open CREATES it and its first stretch, so it is read only when the person
 * opens it, never to prefetch one nobody started. Keyed by `threadKey(address)`.
 */
export const gemieThread = answerSource('gemies.thread', {
  ...gemieRead,
  persist: true,
  key: (_api: GemieApi, thread: GemieThreadAddress) => threadKey(thread),
  stale: THREAD_STALE_MS,
  retry: retryThreadRead,
  load: async ({ signal }, api, thread) =>
    (await api.get<GemieThreadInfo>(AGENT_ROUTES.thread(thread), { signal })).data,
});

/**
 * A message of a thread, by its cursor (unique to one message by construction). `message` finds
 * one by its conversation and its id (the cursor of a message the server wrote, which has none).
 */
export const ThreadMessages = entity<WireThreadMessage>('gemies.thread-message', {
  id: (message) => message.cursor,
  index: {
    message: (message) => threadMessageKey(message.conversationId, message.id ?? message.cursor),
  },
});

/** The `message` index value of a thread message. */
export function threadMessageKey(conversationId: string, messageId: string): string {
  return `${conversationId}\u0000${messageId}`;
}

/**
 * A page as a list holds it: newest first. The server sends each page oldest-first and each page is
 * the window before the last, so reversing each page keeps the whole list newest-first, and the
 * list read backwards is reading order.
 */
function newestFirst(page: ThreadPage) {
  return { items: [...page.messages].reverse(), next: page.nextCursor };
}

/** Everything said in a thread, going back from its present, newest first. */
export const ThreadHistory = list('gemies.thread-history', { of: ThreadMessages });

export const threadHistory = source(ThreadHistory, {
  ...gemieRead,
  key: (_api: GemieApi, thread: GemieThreadAddress) => threadKey(thread),
  retry: retryThreadRead,
  load: async ({ cursor, signal }, api, thread) =>
    newestFirst(
      (
        await api.get<ThreadPage>(AGENT_ROUTES.threadMessages(thread), {
          signal,
          params: { limit: PAGE_SIZE, before: cursor },
        })
      ).data,
    ),
});

/** A stretch of a thread's past around one message, newest first, opened from a search hit. */
export const ThreadWindow = list('gemies.thread-window', { of: ThreadMessages });

/**
 * `at=` rather than `before=` for the first page: `before` is exclusive, so the one message the
 * window exists to reveal would be the one missing from it. Further back it pages like the history.
 */
export const threadWindow = source(ThreadWindow, {
  ...gemieRead,
  key: (_api: GemieApi, thread: GemieThreadAddress, at: string) =>
    `${threadKey(thread)}\u0000${at}`,
  retry: retryThreadRead,
  load: async ({ cursor, signal }, api, thread, at) =>
    newestFirst(
      (
        await api.get<ThreadPage>(AGENT_ROUTES.threadMessages(thread), {
          signal,
          params:
            cursor === undefined
              ? { limit: WINDOW_SIZE, at }
              : { limit: WINDOW_SIZE, before: cursor },
        })
      ).data,
    ),
});

/** What was said cannot change, so a query already asked is answered from the store. */
export const threadSearch = answerSource('gemies.thread-search', {
  ...gemieRead,
  key: (_api: GemieApi, thread: GemieThreadAddress, query: string) =>
    `${threadKey(thread)}\u0000${query}`,
  stale: 5 * 60_000,
  retry: retryThreadRead,
  load: async ({ signal }, api, thread, query) =>
    (
      await api.get<{ hits: ThreadSearchHit[] }>(AGENT_ROUTES.threadSearch(thread), {
        signal,
        params: { q: query, limit: HIT_LIMIT },
      })
    ).data.hits,
});
