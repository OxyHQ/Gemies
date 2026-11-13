/**
 * The routes the SDK calls — all of them on the Gemies product API, `/v1`.
 *
 * The SDK is embedded by every Oxy app on its own web origin, so it may only call a surface that
 * answers a browser from any origin with a bearer and no cookies: `/v1` (public CORS). The
 * cookie-era routes (`/conversations`, `/alia/chat`) answer Alia's own origins alone and are not
 * for the SDK. `tests/runtime/v1-only.test.ts` fails if the transport builds a URL outside `/v1`.
 *
 * `/v1/chat/completions` is the product's turn route: the same handler `/alia/chat` mounts, with
 * every `alia.*` event, `conversationId` and the stored history.
 */
export const API_ROUTES = {
  chat: '/v1/chat/completions',
  /** The answer to an awaited host action, read by the turn that is waiting for it. */
  hostResults: (turnId: string) => `/v1/chat/turns/${encodeURIComponent(turnId)}/host-results`,
  /** The person's folders and projects (`runtime/collections.ts`). */
  collections: {
    list: '/v1/conversations/collections',
    create: '/v1/conversations/collections',
    import: '/v1/conversations/collections/import',
    one: (id: string) => `/v1/conversations/collections/${encodeURIComponent(id)}`,
    member: (id: string, conversationId: string) =>
      `/v1/conversations/collections/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversationId)}`,
  },
  conversations: {
    list: '/v1/conversations',
    save: '/v1/conversations',
    create: '/v1/conversations/new',
    get: (id: string) => `/v1/conversations/${id}`,
    remove: (id: string) => `/v1/conversations/${id}`,
    /**
     * Empty a thread without removing it: every message goes, the row and its
     * title stay. A sub-resource DELETE rather than a `/clear` verb, because
     * what is being deleted is the message collection and nothing else.
     */
    clearMessages: (id: string) => `/v1/conversations/${id}/messages`,
    /** The person has seen it: its unread count goes to zero on every surface. */
    read: (id: string) => `/v1/conversations/${id}/read`,
    /** Its own marks: `{ pinned?, favorite? }`. */
    marks: (id: string) => `/v1/conversations/${id}`,
    vote: (id: string, messageId: string) => `/v1/conversations/${id}/messages/${messageId}/vote`,
    react: (id: string, messageId: string) =>
      `/v1/conversations/${id}/messages/${messageId}/reactions`,
    /** Mint (`POST { ttlHours }`) or revoke (`DELETE`) the conversation's read-only share link. */
    share: (id: string) => `/v1/conversations/${id}/share`,
  },
  /** An agent any app can open: who it is, and which of Alia's features it gates. */
  agents: {
    profile: (id: string) => `/v1/agents/${encodeURIComponent(id)}/profile`,
    features: (id: string) => `/v1/agents/${encodeURIComponent(id)}/features`,
  },
  /** A shared conversation, read without a session. */
  shared: (token: string) => `/v1/shared/${encodeURIComponent(token)}`,
} as const;

/**
 * Which thread a person holds with a gemie: by the gemie's Oxy handle, or by its id — Alia's, whose
 * Oxy account has no handle yet (ADR 0034). The two address the SAME thread and the same routes.
 */
export type GemieThreadAddress = { readonly handle: string } | { readonly gemieId: string };

/** The thread's own path; its messages and its search hang off it. */
function threadPath(thread: GemieThreadAddress): string {
  return 'handle' in thread
    ? `/agents/thread/${encodeURIComponent(thread.handle)}`
    : `/agents/${encodeURIComponent(thread.gemieId)}/thread`;
}

/**
 * The thread's cache key: the handle, as it always was (a host's own thread query lives under
 * `gemieQueryKeys.threads.all(handle)`), or `id:<gemieId>`, which no handle can be.
 */
export function threadKey(thread: GemieThreadAddress): string {
  return 'handle' in thread ? thread.handle : `id:${thread.gemieId}`;
}

/**
 * An agent's thread and its runs. These belong to Alia's own clients (the app), which are the only
 * ones with agents of their own: `agentId`, `threadHandle` and the agent panel are not for an
 * embedding Oxy app, and these routes answer Alia's origins alone, like `/conversations` does.
 */
export const AGENT_ROUTES = {
  /**
   * Open the thread: `{ agent, conversationId, threadId }`, the active stretch (created the first
   * time the two speak) and, for a gemie whose chats are loose (Alia), the thread row.
   */
  thread: (thread: GemieThreadAddress) => threadPath(thread),
  /** A page of the thread, oldest-first, crossing the seams between its conversations. */
  threadMessages: (thread: GemieThreadAddress) => `${threadPath(thread)}/messages`,
  /** Everything said in the thread that matches, across every conversation in it. */
  threadSearch: (thread: GemieThreadAddress) => `${threadPath(thread)}/search`,
  /** What a run of an agent has done so far, to hydrate the live feed. */
  sessionStatus: (sessionId: string) => `/agents/sessions/${sessionId}/status`,
} as const;

/**
 * The caller's connected WhatsApp and Telegram accounts (ADR 0035 as amended): theirs, connected
 * once, and granted to the gemies that may use them.
 */
export const ACCOUNT_ROUTES = {
  /** Every account, with its grants, the gemies to grant and the platforms; `POST` connects one. */
  all: '/me/accounts',
  /** One account: `PATCH` its answering gemie and replies, `DELETE` it. */
  one: (accountId: string) => `/me/accounts/${encodeURIComponent(accountId)}`,
  /** A gemie's grant of one account: `PUT` grants it, `DELETE` revokes it. */
  grant: (accountId: string, gemieId: string) =>
    `/me/accounts/${encodeURIComponent(accountId)}/gemies/${encodeURIComponent(gemieId)}`,
} as const;
