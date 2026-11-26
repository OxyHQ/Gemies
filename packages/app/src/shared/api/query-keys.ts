/**
 * The app's React Query keys. Every query is the app's own and lives in memory only: the account's
 * data a returning person sees first (their agents and spaces, and the SDK's conversations,
 * collections and threads) is a bloom-data answer in the account's store, persisted there
 * (docs/instant-loading.md). An account change drops every query (`useAccountLifecycle`).
 */

/** "Avísame de emails importantes": its write, so a toggle can tell its own writes apart. */
export const EMAIL_ALERTS_MUTATION_KEY = ['email-alerts-update'] as const;

export const queryKeys = {
  /** "Avísame de emails importantes" for Alia and each owned agent. */
  emailAlerts: ['email-alerts'] as const,
  skills: {
    catalogue: (filters?: Record<string, string | undefined>) =>
      ['skills', 'catalogue', filters ?? {}] as const,
    installed: ['skills', 'installed'] as const,
    detail: (idOrName: string) => ['skills', 'detail', idOrName] as const,
  },
  agents: {
    /** The coding-agent CLIs the person connected (Settings > External agents), with presence. */
    external: ['agents', 'external'] as const,
    /** The folders an external agent's sessions worked in, newest first (ADR 0043). */
    externalFolders: (agentId: string) => ['agents', 'external', agentId, 'folders'] as const,
    externalComputer: (agentId: string) => ['agents', 'external', agentId, 'computer'] as const,
    /** Owner-present work handshake, one per agent the person owns (`useMyAgents`). */
    workAuthority: (ownerId: string, agentId: string) =>
      ['agent-work-authority', ownerId, agentId] as const,
    /**
     * The CATALOGUE: everything published, by anybody, narrowed by whatever the
     * screen is filtering on. A different question from the person's own list
     * (`useMyAgents`, the account's), and the filters are part of the key
     * because two filters are two answers.
     */
    catalogue: (params?: object) => ['agents', 'catalogue', params ?? {}] as const,
    /** One agent, whole, as the detail and edit screens read it. */
    detail: (id: string) => ['agents', 'detail', id] as const,
    /** The same card, asked for by handle (`/@username/details`, `/@username/edit`). */
    byHandle: (handle: string) => ['agents', 'by-handle', handle] as const,
    /** One agent's reviews, and the caller's own among them. */
    reviews: (id: string) => ['agents', 'reviews', id] as const,
    /** What one agent remembers about the caller: its files, and one file's content. */
    memory: (id: string) => ['agents', 'memory', id] as const,
    memoryFile: (id: string, path: string) => ['agents', 'memory', id, path] as const,
    /** What one agent subscribes to, and what waits in its inbox (ADR 0026). */
    subscriptions: (id: string) => ['agents', 'subscriptions', id] as const,
    inbox: (id: string) => ['agents', 'inbox', id] as const,
    /** The gemie's own Telegram bot (ADR 0037). */
    telegramBot: (id: string) => ['agents', 'telegram-bot', id] as const,
  },
  credits: {
    info: ['credits'] as const,
    price: ['credit-price'] as const,
    /** The last turn's spending warning, written by the stream and consumed when shown. */
    usageWarning: ['usage-warning'] as const,
  },
  billing: {
    packages: ['credit-packages'] as const,
    plans: (product?: string) => ['subscription-plans', product] as const,
    subscription: (product?: string) => ['subscription', product] as const,
    subscriptionPoll: (product?: string) => ['subscription-poll', product] as const,
    transactions: (limit?: number, offset?: number) => ['transactions', limit, offset] as const,
    entitlements: ['entitlements'] as const,
  },
  referrals: {
    info: ['referral-info'] as const,
    history: ['referral-history'] as const,
  },
  /** Settings > Writing style: the profile learnt from the person's messages (memory only). */
  writingStyle: ['writing-style'] as const,
  /** Settings > Security: recent threats and the audit summary (memory only). */
  audit: {
    threats: ['audit', 'threats'] as const,
    summary: ['audit', 'summary'] as const,
  },
  suggestions: {
    welcome: ['suggestions', 'welcome'] as const,
    search: (query: string) => ['suggestions', 'search', query] as const,
  },
} as const;
