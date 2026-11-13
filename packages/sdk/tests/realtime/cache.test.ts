import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyRealtimeToCache, bumpConversation } from '../../src/realtime/cache';
import type { RealtimeConversationRow, RealtimeFrame } from '../../src/realtime/contract';
import { gemieQueryKeys } from '../../src/runtime/query-keys';
import type { Conversation, ConversationsInfiniteData, Message } from '../../src/runtime/types';

/**
 * Realtime events into the runtime's cache (`src/realtime/cache.ts`): a new message moves its
 * conversation to the top with its preview and unread count, an open conversation gains the
 * messages by id without doubling the copy it drew, a deletion leaves every list, and replaying an
 * event changes nothing.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 13, 10, minute));
const conversation = (
  id: string,
  minute: number,
  extra: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  createdAt: at(0),
  updatedAt: at(minute),
  messages: [],
  agentId: null,
  ...extra,
});
const row = (id: string, minute: number, extra: Partial<RealtimeConversationRow> = {}) =>
  ({
    id,
    title: id,
    lastMessage: 'hola',
    source: 'app',
    agentId: null,
    threadId: null,
    memberAgentIds: [],
    spaceId: null,
    app: null,
    unreadCount: 1,
    createdAt: at(0).toISOString(),
    updatedAt: at(minute).toISOString(),
    ...extra,
  }) satisfies RealtimeConversationRow;
const event = (data: unknown, type = 'conversation', seq = 1) =>
  ({ v: 1, type, data, seq }) as RealtimeFrame;
const list = (client: QueryClient, key: readonly unknown[] = gemieQueryKeys.conversations.all) =>
  (client.getQueryData<ConversationsInfiniteData>(key)?.pages ?? []).flatMap((page) =>
    page.conversations.map((c) => c.id),
  );

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  client.setQueryData<ConversationsInfiniteData>(gemieQueryKeys.conversations.all, {
    pages: [
      {
        conversations: [conversation('a', 30), conversation('b', 20), conversation('c', 10)],
        nextCursor: null,
        hasMore: false,
      },
    ],
    pageParams: [undefined],
  });
});

describe('a conversation event', () => {
  it('moves the row to the top with its preview and unread count', () => {
    applyRealtimeToCache(
      client,
      event({ conversation: row('c', 40, { unreadCount: 2 }), thread: {} }),
    );
    expect(list(client)).toEqual(['c', 'a', 'b']);
    const top = client.getQueryData<ConversationsInfiniteData>(gemieQueryKeys.conversations.all)
      ?.pages[0]?.conversations[0];
    expect(top).toMatchObject({ id: 'c', lastMessage: 'hola', unreadCount: 2 });
  });

  it('adds a conversation made elsewhere, and is the same when replayed', () => {
    const created = event({ conversation: row('new', 50), thread: {} });
    applyRealtimeToCache(client, created);
    applyRealtimeToCache(client, created);
    expect(list(client)).toEqual(['new', 'a', 'b', 'c']);
  });

  it('never puts an older copy over a newer one (a replay over a fresher read)', () => {
    applyRealtimeToCache(
      client,
      event({ conversation: row('a', 5, { title: 'old' }), thread: {} }),
    );
    expect(list(client)).toEqual(['a', 'b', 'c']);
    expect(
      client.getQueryData<ConversationsInfiniteData>(gemieQueryKeys.conversations.all)?.pages[0]
        ?.conversations[0]?.title,
    ).toBe('a');
  });

  it('keeps a narrowed list to what it was narrowed to', () => {
    const key = gemieQueryKeys.conversations.filtered({ agentId: 'pepe' });
    client.setQueryData<ConversationsInfiniteData>(key, {
      pages: [{ conversations: [], nextCursor: null, hasMore: false }],
      pageParams: [undefined],
    });
    applyRealtimeToCache(client, event({ conversation: row('x', 60), thread: {} }));
    applyRealtimeToCache(
      client,
      event({ conversation: row('y', 61, { agentId: 'pepe' }), thread: {} }),
    );
    expect(list(client, key)).toEqual(['y']);
  });

  it('gives an open conversation the messages it gained, replacing the copy drawn under the same id', () => {
    const drawn: Message = { id: 'm2', role: 'assistant', content: 'stream…' };
    client.setQueryData(gemieQueryKeys.conversations.detail('a'), {
      ...conversation('a', 30),
      messages: [{ id: 'm1', role: 'user', content: 'hola' }, drawn],
    });
    const appended: Message[] = [
      { id: 'm2', role: 'assistant', content: 'Hola, ¿qué tal?' },
      { id: 'm3', role: 'assistant', content: 'Te escribo luego' },
    ];
    applyRealtimeToCache(client, event({ conversation: row('a', 31), thread: {}, appended }));
    applyRealtimeToCache(client, event({ conversation: row('a', 31), thread: {}, appended }));
    const detail = client.getQueryData<Conversation>(gemieQueryKeys.conversations.detail('a'));
    expect(detail?.messages.map((m) => [m.id, m.content])).toEqual([
      ['m1', 'hola'],
      ['m2', 'Hola, ¿qué tal?'],
      ['m3', 'Te escribo luego'],
    ]);
    expect(detail?.unreadCount).toBe(1);
  });
});

describe('a deletion', () => {
  it('leaves every list and forgets the conversation', () => {
    client.setQueryData(gemieQueryKeys.conversations.detail('b'), conversation('b', 20));
    applyRealtimeToCache(client, event({ conversationId: 'b' }, 'conversation.deleted'));
    expect(list(client)).toEqual(['a', 'c']);
    expect(client.getQueryData(gemieQueryKeys.conversations.detail('b'))).toBeUndefined();
  });
});

describe('sending', () => {
  it('moves the conversation to the top with the words just sent', () => {
    bumpConversation(client, 'c', 'una pregunta');
    expect(list(client)).toEqual(['c', 'a', 'b']);
    expect(
      client.getQueryData<ConversationsInfiniteData>(gemieQueryKeys.conversations.all)?.pages[0]
        ?.conversations[0]?.lastMessage,
    ).toBe('una pregunta');
  });
});
