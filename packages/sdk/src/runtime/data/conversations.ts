/**
 * The person's conversations, held in the signed-in account's `@oxy.so/bloom-data` store (the one
 * Services' `OxyProvider` opens with the session): one `Conversations` record per conversation,
 * the lists that order them (`ConversationList`, one per filter) and the writes that change them.
 *
 * Each account has its own store, so a switch never shows the previous account's conversations,
 * and an answer that lands for an account that was left goes to its closed store and is dropped.
 * Records and lists are copied to the account's durable store, so the sidebar paints from the last
 * session.
 *
 * A record is the conversation as the API sends it, JSON throughout. A list row carries no
 * `messages`; the conversation's own read (`conversation`) does, and a row arriving later (a list
 * page, a realtime event) leaves them in place.
 */
import { action, currentStore, entity, list, source } from '@oxy.so/bloom-data';
import type { RealtimeConnection } from '../../realtime/connection';
import type { GemieApi } from '../api';
import type { OfflineConversationStore } from '../config';
import { errorStatus } from '../error-utils';
import { normalizeConversationMessages } from '../message-history';
import { createRandomUuid } from '../random-uuid';
import { API_ROUTES } from '../routes';
import type { Conversation, Message } from '../types';
import { gemieRead } from './read';

const PAGE_SIZE = 20;
const FIVE_MINUTES = 5 * 60_000;

/** What a conversation list may be narrowed to (`GET /v1/conversations?agentId=&app=&kind=`). */
export interface ConversationsFilter {
  /** Only the conversations with this agent. */
  agentId?: string;
  /** Only the conversations started in this app, by its slug (`docs/agent-embedding.md` §6). */
  app?: string;
  /**
   * The conversations the person's gemies have with each other (`gemies`, ADR 0042) instead of the
   * person's own, which are the default and never include them.
   */
  kind?: 'gemies';
}

/** The list key of a filter: `all` for the person's own, unnarrowed list. */
export function conversationsKey({ agentId, app, kind }: ConversationsFilter = {}): string {
  if (agentId === undefined && app === undefined && kind === undefined) return 'all';
  return JSON.stringify([agentId ?? null, app ?? null, kind ?? null]);
}

/** The filter a list key was made from. */
export function filterOfKey(key: string): ConversationsFilter {
  if (key === 'all') return {};
  const [agentId, app, kind] = JSON.parse(key) as [string | null, string | null, 'gemies' | null];
  return {
    ...(agentId === null ? {} : { agentId }),
    ...(app === null ? {} : { app }),
    ...(kind === null ? {} : { kind }),
  };
}

/** Whether a conversation belongs in a list of `filter`. */
export function matchesFilter(filter: ConversationsFilter, row: Conversation): boolean {
  // The person's own lists never hold a conversation between their gemies, and that list holds
  // nothing else (ADR 0042).
  if ((filter.kind ?? 'person') !== (row.kind ?? 'person')) return false;
  if (filter.agentId !== undefined && row.agentId !== filter.agentId) return false;
  if (filter.app !== undefined && row.app !== filter.app) return false;
  return true;
}

/** A signal that a conversation no longer exists on the server. */
export class ConversationNotFoundError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super('Conversation not found');
    this.conversationId = conversationId;
    this.name = 'ConversationNotFoundError';
  }
}

/**
 * The offline copy of the conversations: what a session whose token failed (a 401) reads and
 * writes instead of the server. Without a store configured it holds nothing, and the 401 is the
 * caller's to handle.
 */
export class OfflineConversations {
  private readonly store: OfflineConversationStore | null;

  constructor(store: OfflineConversationStore | null) {
    this.store = store;
  }

  get available(): boolean {
    return this.store !== null;
  }

  async read(): Promise<Conversation[]> {
    const stored = await this.store?.getItem();
    return stored ? (JSON.parse(stored) as Conversation[]) : [];
  }

  async write(conversations: Conversation[]): Promise<void> {
    await this.store?.setItem(JSON.stringify(conversations));
  }

  async remove(id: string): Promise<void> {
    if (!this.store) return;
    try {
      const conversations = await this.read();
      const remaining = conversations.filter((conversation) => conversation.id !== id);
      if (remaining.length !== conversations.length) await this.write(remaining);
    } catch {
      // A malformed offline copy cannot make a valid server answer invalid.
    }
  }
}

/** What the conversation reads and writes need; the hooks pass the provider's (`useConversationsClient`). */
export interface ConversationsClient {
  api: GemieApi;
  offline: OfflineConversations;
  /** The title of a chat created while the session is unavailable. */
  newChatTitle: string;
  /** The chat's app, which labels a conversation it creates (`GemieRuntimeConfig.app`). */
  app: string | undefined;
  /** Told the account's realtime cursor each read carried, so no event is lost behind it. */
  realtime: RealtimeConnection | null;
}

/** A conversation as the API answers it, with its optional fields. */
type ApiConversation = Conversation & { realtimeSeq?: number };

/** A list row: the conversation without messages, so it never empties a held conversation. */
function rowOf({ messages: _messages, realtimeSeq: _seq, ...row }: ApiConversation): Conversation {
  return row;
}

/** Message content is a string or parts; a preview needs the text either way. */
function messageText(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

// ── Records and lists ───────────────────────────────────────────────

export const Conversations = entity<Conversation>('gemies.conversation', {
  id: (conversation) => conversation.id,
  persist: { version: 1 },
  // A row (a list page, a realtime event) carries no messages: it keeps the ones held.
  combine: (incoming, held) =>
    incoming.messages === undefined && held.messages !== undefined
      ? { ...incoming, messages: held.messages }
      : incoming,
});

/** The person's conversations, newest first, one list per filter (`conversationsKey`). */
export const ConversationList = list('gemies.conversations', { of: Conversations, persist: true });

/**
 * The list of `filter`, a page at a time. A 401 is the session's to resolve, not a read to repeat.
 */
export const conversationList = source(ConversationList, {
  ...gemieRead,
  key: (_client: ConversationsClient, filter: ConversationsFilter) => conversationsKey(filter),
  stale: FIVE_MINUTES,
  retry: (failureCount, error) =>
    errorStatus(error) !== 401 && gemieRead.retry(failureCount, error),
  load: async ({ cursor, signal }, client, { agentId, app, kind }) => {
    const { data } = await client.api.get<{
      conversations: ApiConversation[];
      nextCursor: string | null;
      hasMore: boolean;
      realtimeSeq?: number;
    }>(API_ROUTES.conversations.list, {
      signal,
      params: {
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(app === undefined ? {} : { app }),
        ...(kind === undefined ? {} : { kind }),
      },
    });
    if (typeof data.realtimeSeq === 'number') client.realtime?.noteSnapshot(data.realtimeSeq);
    return {
      items: data.conversations.map(rowOf),
      next: data.nextCursor,
      hasMore: data.hasMore,
    };
  },
});

/** Reads one conversation with its messages, falling back to the offline copy on a 401. */
export async function fetchConversation(
  client: ConversationsClient,
  id: string,
  signal?: AbortSignal,
): Promise<Conversation> {
  try {
    const { data } = await client.api.get<ApiConversation>(API_ROUTES.conversations.get(id), {
      signal,
    });
    if (typeof data.realtimeSeq === 'number') client.realtime?.noteSnapshot(data.realtimeSeq);
    const { realtimeSeq: _seq, ...conversation } = data;
    return { ...conversation, messages: normalizeConversationMessages(data.messages ?? []) };
  } catch (error: unknown) {
    const status = errorStatus(error);
    // A server-side 404 is authoritative for an authenticated request. Keeping an older offline
    // copy here resurrects a deleted conversation and makes every later read and write hit the
    // same missing id again.
    if (status === 404) {
      await client.offline.remove(id);
      throw new ConversationNotFoundError(id);
    }
    // An unavailable authenticated session can still read its offline copy.
    if (status === 401) {
      const conversation = (await client.offline.read()).find((c) => c.id === id);
      if (conversation) {
        return {
          ...conversation,
          messages: normalizeConversationMessages(conversation.messages ?? []),
        };
      }
    }
    throw error;
  }
}

/**
 * One conversation with its messages. A missing conversation is deterministic: retrying only
 * repeats the same 404, so it is never retried (nor is a prefetch, which a refusal answers).
 */
export const conversation = source(Conversations, {
  ...gemieRead,
  key: (_client: ConversationsClient, id: string) => id,
  stale: FIVE_MINUTES,
  retry: 0,
  load: ({ signal }, client, id) => fetchConversation(client, id, signal),
});

// ── Placement ───────────────────────────────────────────────────────

const timeOf = (row: Conversation | undefined): number => (row ? Date.parse(row.updatedAt) : 0);

/**
 * A conversation as the server says it is now, where the lists' order puts it: newest
 * `updatedAt` first, in every held list it belongs to, and out of every one it does not. A copy
 * already newer than this one is kept (an event replayed over a fresher read). A row older than
 * everything a list holds, not in it already, belongs to a page not read yet. Idempotent.
 */
export function placeConversation(row: Conversation): void {
  const store = currentStore();
  const held = Conversations.get(row.id);
  if (held && timeOf(held) > timeOf(row)) return;
  store.batch(() => {
    Conversations.put(row);
    const time = timeOf(row);
    for (const key of ConversationList.keys()) {
      ConversationList.set(key, (current) => {
        if (!current) return current;
        const others = current.ids.filter((id) => id !== row.id);
        const present = others.length !== current.ids.length;
        if (!matchesFilter(filterOfKey(key), row)) {
          return present ? { ...current, ids: others } : current;
        }
        const at = others.findIndex((id) => timeOf(Conversations.get(id)) <= time);
        if (at < 0 && !present && current.hasMore) return current;
        const ids = [...others];
        ids.splice(at < 0 ? ids.length : at, 0, row.id);
        return { ...current, ids };
      });
    }
  });
}

/**
 * The person just sent in a conversation: its row goes to the top of every list that shows it,
 * with their words, now. The server's `conversation` event replaces this with what it stored.
 */
export function bumpConversation(id: string, preview: string): void {
  if (!Conversations.has(id)) return;
  currentStore().batch(() => {
    Conversations.merge(id, {
      ...(preview ? { lastMessage: preview.slice(0, 100) } : {}),
      updatedAt: new Date().toISOString(),
    });
    for (const key of ConversationList.keys()) {
      if (ConversationList.get(key)?.ids.includes(id)) ConversationList.move(key, id, 0);
    }
  });
}

/** Messages merged by id: a copy the client drew under the same id is replaced, never doubled. */
export function mergeMessages(
  previous: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  if (incoming.length === 0) return [...previous];
  const next = [...previous];
  for (const message of incoming) {
    if (!message?.id) continue;
    const index = next.findIndex((m) => m.id === message.id);
    if (index >= 0) next[index] = { ...next[index], ...message };
    else next.push(message);
  }
  return next;
}

/** A new or saved conversation at the top of the person's own list (`all`), if it is held. */
function toTop(id: string, moveExisting: boolean): void {
  const held = ConversationList.get('all');
  if (!held) return;
  if (!held.ids.includes(id)) ConversationList.insert('all', [id], 0);
  else if (moveExisting) ConversationList.move('all', id, 0);
}

/** Stores what a write answered: merged into the held record (keeping what it does not carry). */
function upsert(record: Conversation): void {
  if (!Conversations.merge(record.id, record)) Conversations.put(record);
}

/** The conversation without its preview: what a clear leaves (`lastMessage` is not sent). */
function withoutPreview({ lastMessage: _last, ...rest }: Conversation): Conversation {
  return rest;
}

/** Every held list read again: what a write the server reshaped (a clear) leaves behind. */
export function refreshConversationLists(client: ConversationsClient): void {
  for (const key of ConversationList.keys()) {
    void conversationList.refresh(client, filterOfKey(key));
  }
}

/** One retry, a second later: the rule the runtime's writes always had. */
async function retryOnce<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return write();
  }
}

// ── Writes ──────────────────────────────────────────────────────────

/**
 * The person has seen a conversation: its unread count is zero at once here, and on every other
 * surface through the server's `conversation` event. A refusal puts the count back.
 */
export const markConversationRead = action({
  key: (_client: ConversationsClient, id: string) => `gemies.conversation.read:${id}`,
  optimistic: (_client, id) => {
    Conversations.merge(id, { unreadCount: 0 });
  },
  run: async (client, id) => {
    await client.api.post(API_ROUTES.conversations.read(id), {});
  },
});

export interface SaveConversationInput {
  id: string;
  messages: Message[];
  title?: string;
}

async function postSave(
  client: ConversationsClient,
  { id, messages, title }: SaveConversationInput,
): Promise<Conversation> {
  try {
    const { data } = await retryOnce(() =>
      client.api.post<ApiConversation>(API_ROUTES.conversations.save, {
        conversationId: id,
        messages,
        ...(title && { title }),
        ...(client.app === undefined ? {} : { app: client.app }),
      }),
    );
    return {
      id: data.id,
      title: data.title,
      lastMessage: data.lastMessage,
      source: data.source,
      app: data.app,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messages,
    };
  } catch (error: unknown) {
    if (errorStatus(error) !== 401) throw error;
    // Unauthorized: the offline copy keeps it.
    const conversations = await client.offline.read();
    const existing = conversations.find((c) => c.id === id);
    const now = new Date().toISOString();
    const saved: Conversation = {
      id,
      title:
        title ||
        messageText(messages.find((m) => m.role === 'user')).slice(0, 50) ||
        client.newChatTitle,
      lastMessage: messageText(messages[messages.length - 1]).slice(0, 100) || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages,
    };
    await client.offline.write([saved, ...conversations.filter((c) => c.id !== id)]);
    return saved;
  }
}

/** Saves a conversation's messages (and title): drawn at once, put back if refused. */
export const saveConversation = action({
  optimistic: (_client: ConversationsClient, { id, messages, title }: SaveConversationInput) => {
    Conversations.merge(id, { messages, ...(title ? { title } : {}) });
  },
  run: (client, input) => postSave(client, input),
  settle: (saved: Conversation) => {
    upsert(saved);
    toTop(saved.id, true);
  },
});

/**
 * Renames a conversation. The API has no title-only route: `POST /conversations` writes the title
 * AND replaces the messages, so the whole thread is read fresh first and saved back with the new
 * title (a row seeded from a list has no messages, and saving it would empty the thread).
 */
export const renameConversation = action({
  key: (_client: ConversationsClient, id: string, _title: string) =>
    `gemies.conversation.rename:${id}`,
  optimistic: (_client, id, title) => {
    Conversations.merge(id, { title });
  },
  run: async (client, id, title) => {
    const fresh = await fetchConversation(client, id);
    return postSave(client, { id, messages: fresh.messages ?? [], title });
  },
  settle: (saved: Conversation) => {
    upsert(saved);
    toTop(saved.id, true);
  },
});

/** Deletes a conversation: it leaves every list at once, and comes back if refused. */
export const deleteConversation = action({
  key: (_client: ConversationsClient, id: string) => `gemies.conversation.delete:${id}`,
  optimistic: (_client, id) => {
    for (const key of ConversationList.keys()) ConversationList.remove(key, [id]);
  },
  run: async (client, id) => {
    try {
      await retryOnce(() => client.api.delete(API_ROUTES.conversations.remove(id)));
    } catch (error: unknown) {
      if (errorStatus(error) !== 401) throw error;
      // Unauthorized: it leaves the offline copy.
      await client.offline.write((await client.offline.read()).filter((c) => c.id !== id));
    }
    return id;
  },
  settle: (id: string) => {
    Conversations.remove(id);
  },
});

/**
 * Empties a conversation on the server, keeping the conversation. Its messages go at once and come
 * back exactly as they were if the server refuses; once it accepts, the row loses its preview (the
 * server dropped `lastMessage` in the same transaction) and the conversation and the lists are
 * read again, so the server's own answer (the moved `updatedAt`) replaces the local guess.
 */
export const clearConversation = action({
  key: (_client: ConversationsClient, id: string) => `gemies.conversation.clear:${id}`,
  optimistic: (_client, id) => {
    Conversations.merge(id, { messages: [] });
  },
  run: async (client, id) => {
    try {
      await retryOnce(() => client.api.delete(API_ROUTES.conversations.clearMessages(id)));
    } catch (error: unknown) {
      if (errorStatus(error) !== 401) throw error;
      // Unauthorized: the offline copy is emptied instead.
      const now = new Date().toISOString();
      await client.offline.write(
        (await client.offline.read()).map((c) =>
          c.id === id ? { ...withoutPreview(c), messages: [], updatedAt: now } : c,
        ),
      );
    }
    return id;
  },
  settle: (id: string, client: ConversationsClient) => {
    Conversations.update(id, (held) => ({ ...withoutPreview(held), messages: [] }));
    void conversation.refresh(client, id);
    refreshConversationLists(client);
  },
});

export interface CreateConversationInput {
  agentId?: string;
  /** Two to six agents: a group conversation, answered by each in turn. */
  agentIds?: readonly string[];
  /** The thread row whose next stretch this is (`GemieThreadInfo.threadId`). */
  threadId?: string;
}

/**
 * Creates a conversation (optionally the next stretch of an agent's thread): it goes to the top of
 * the person's list when the server answers with its id.
 */
export const createConversation = action({
  run: async (client: ConversationsClient, input: CreateConversationInput = {}) => {
    try {
      const { data } = await client.api.post<ApiConversation>(API_ROUTES.conversations.create, {
        ...(input.agentId && { agentId: input.agentId }),
        ...(input.agentIds && { agentIds: input.agentIds }),
        ...(input.threadId && { threadId: input.threadId }),
        ...(client.app === undefined ? {} : { app: client.app }),
      });
      return { ...rowOf(data), messages: [] };
    } catch (error: unknown) {
      if (errorStatus(error) !== 401 || !client.offline.available) throw error;
      // Unauthorized: it is created in the offline copy.
      const now = new Date().toISOString();
      const created: Conversation = {
        id: createRandomUuid(),
        title: client.newChatTitle,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      await client.offline.write([created, ...(await client.offline.read())]);
      return created;
    }
  },
  settle: (created: Conversation) => {
    Conversations.put(created);
    toTop(created.id, false);
  },
});
