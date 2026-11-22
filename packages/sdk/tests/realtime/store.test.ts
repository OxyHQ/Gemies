import { type Store, withStore } from '@oxy.so/bloom-data';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RealtimeConversationRow, RealtimeFrame } from '../../src/realtime/contract';
import { applyRealtimeFrame } from '../../src/realtime/store';
import {
  bumpConversation,
  Conversations,
  conversationsKey,
} from '../../src/runtime/data/conversations';
import type { Conversation, Message } from '../../src/runtime/types';
import { freshStore, heldConversation, listIds, seedList } from '../support/data-store';

/**
 * Realtime events into the account's store (`src/realtime/store.ts`): a new message moves its
 * conversation to the top with its preview and unread count, an open conversation gains the
 * messages by id without doubling the copy it drew, a deletion leaves every list, and replaying an
 * event changes nothing.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 13, 10, minute)).toISOString();
const conversation = (
  id: string,
  minute: number,
  extra: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  createdAt: at(0),
  updatedAt: at(minute),
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
    createdAt: at(0),
    updatedAt: at(minute),
    ...extra,
  }) satisfies RealtimeConversationRow;
const event = (data: unknown, type = 'conversation', seq = 1) =>
  ({ v: 1, type, data, seq }) as RealtimeFrame;

let store: Store;
const apply = (frame: RealtimeFrame) => withStore(store, () => applyRealtimeFrame(frame));

beforeEach(() => {
  store = freshStore();
  seedList(store, [conversation('a', 30), conversation('b', 20), conversation('c', 10)]);
});

describe('a conversation event', () => {
  it('moves the row to the top with its preview and unread count', () => {
    apply(event({ conversation: row('c', 40, { unreadCount: 2 }), thread: {} }));
    expect(listIds(store)).toEqual(['c', 'a', 'b']);
    expect(heldConversation(store, 'c')).toMatchObject({ lastMessage: 'hola', unreadCount: 2 });
  });

  it('adds a conversation made elsewhere, and is the same when replayed', () => {
    const created = event({ conversation: row('new', 50), thread: {} });
    apply(created);
    apply(created);
    expect(listIds(store)).toEqual(['new', 'a', 'b', 'c']);
  });

  it('leaves a row older than everything held out of a list with more pages', () => {
    seedList(store, [conversation('a', 30)], { key: 'all', hasMore: true });
    apply(event({ conversation: row('old', 1), thread: {} }));
    expect(listIds(store)).toEqual(['a']);
  });

  it('never puts an older copy over a newer one (a replay over a fresher read)', () => {
    apply(event({ conversation: row('a', 5, { title: 'old' }), thread: {} }));
    expect(listIds(store)).toEqual(['a', 'b', 'c']);
    expect(heldConversation(store, 'a')?.title).toBe('a');
  });

  it('keeps a narrowed list to what it was narrowed to', () => {
    const key = conversationsKey({ agentId: 'pepe' });
    seedList(store, [], { key });
    apply(event({ conversation: row('x', 60), thread: {} }));
    apply(event({ conversation: row('y', 61, { agentId: 'pepe' }), thread: {} }));
    expect(listIds(store, key)).toEqual(['y']);
  });

  it('gives an open conversation the messages it gained, replacing the copy drawn under the same id', () => {
    const drawn: Message = { id: 'm2', role: 'assistant', content: 'stream…' };
    withStore(store, () =>
      Conversations.put({
        ...conversation('a', 30),
        messages: [{ id: 'm1', role: 'user', content: 'hola' }, drawn],
      }),
    );
    const appended: Message[] = [
      { id: 'm2', role: 'assistant', content: 'Hola, ¿qué tal?' },
      { id: 'm3', role: 'assistant', content: 'Te escribo luego' },
    ];
    apply(event({ conversation: row('a', 31), thread: {}, appended }));
    apply(event({ conversation: row('a', 31), thread: {}, appended }));
    const held = heldConversation(store, 'a');
    expect(held?.messages?.map((m) => [m.id, m.content])).toEqual([
      ['m1', 'hola'],
      ['m2', 'Hola, ¿qué tal?'],
      ['m3', 'Te escribo luego'],
    ]);
    expect(held?.unreadCount).toBe(1);
  });

  it('keeps the messages of an open conversation when its row arrives without any', () => {
    withStore(store, () =>
      Conversations.put({
        ...conversation('a', 30),
        messages: [{ id: 'm1', role: 'user', content: 'hola' }],
      }),
    );
    apply(event({ conversation: row('a', 32), thread: {} }));
    expect(heldConversation(store, 'a')?.messages?.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('a deletion', () => {
  it('leaves every list and forgets the conversation', () => {
    apply(event({ conversationId: 'b' }, 'conversation.deleted'));
    expect(listIds(store)).toEqual(['a', 'c']);
    expect(heldConversation(store, 'b')).toBeUndefined();
  });
});

describe('sending', () => {
  it('moves the conversation to the top with the words just sent', () => {
    withStore(store, () => bumpConversation('c', 'una pregunta'));
    expect(listIds(store)).toEqual(['c', 'a', 'b']);
    expect(heldConversation(store, 'c')?.lastMessage).toBe('una pregunta');
  });
});

describe('a store whose account was left', () => {
  it('takes nothing more: a late event is dropped', async () => {
    await store.close();
    apply(event({ conversation: row('late', 70), thread: {} }));
    expect(heldConversation(store, 'late')).toBeUndefined();
  });
});
