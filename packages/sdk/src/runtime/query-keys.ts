/**
 * The React Query keys of the conversation runtime. The host's persister and its sidebar read
 * the same keys the hooks write, so a list shown anywhere is the list the chat updates.
 */
/** What a conversation list may be narrowed to (`GET /v1/conversations?agentId=&app=`). */
export interface ConversationsFilter {
  /** Only the conversations with this agent. */
  agentId?: string;
  /** Only the conversations started in this app, by its slug (`docs/agent-embedding.md` §6). */
  app?: string;
}

export const gemieQueryKeys = {
  conversations: {
    all: ['conversations'] as const,
    detail: (id: string) => ['conversation', id] as const,
    /**
     * The person's conversations narrowed to one agent, one app or both: under `all`, so every
     * write to the list reaches it.
     */
    filtered: (filter: ConversationsFilter) =>
      ['conversations', { agentId: filter.agentId, app: filter.app }] as const,
  },
  /**
   * The person's connected accounts (ADR 0035 as amended): the list with its grants, the code of
   * one being connected and an account's chats. Their own roots, never persisted: phone numbers and
   * a live code stay in memory.
   */
  accounts: {
    all: ['connected-accounts'] as const,
    qr: (accountId: string) => ['connected-account-qr', accountId] as const,
    chats: (accountId: string) => ['connected-account-chats', accountId] as const,
  },
  /** An agent the chat is opened on: its profile and the state of its feature gates. */
  agents: {
    profile: (id: string) => ['alia-agent-profile', id] as const,
    features: (id: string) => ['alia-agent-features', id] as const,
  },
  /** A conversation somebody shared, by its token. */
  shared: (token: string) => ['alia-shared-conversation', token] as const,
  /**
   * An agent's permanent thread: the stretches behind the open conversation, and finding in them.
   * Keyed by `threadKey(address)`: the handle, or `id:<gemieId>`.
   */
  threads: {
    /** The thread itself (which conversation is active): the host's own query lives under it. */
    all: (thread: string) => ['agent-thread', thread] as const,
    /**
     * The history, kept apart from the thread itself: re-reading which conversation is active is
     * cheap and happens whenever a new stretch starts, while the pages behind it are immutable and
     * expensive to refetch.
     */
    messages: (thread: string) => ['agent-thread-messages', thread] as const,
    /** Keyed by the query as typed, so each one is cached and none is re-asked. */
    search: (thread: string, query: string) => ['agent-thread-search', thread, query] as const,
    /** One window of the thread, addressed by the cursor a search hit carries. */
    window: (thread: string, cursor: string) => ['agent-thread-window', thread, cursor] as const,
  },
};
