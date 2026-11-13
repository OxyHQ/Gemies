import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  accountEventHead,
  accountEventsSince,
  appendAccountEvent,
} from '../realtime/accountEventRepository';
import {
  findConversation,
  markConversationRead,
  unreadPerAgent,
  upsertConversation,
} from '../chat/conversationRepository';
import { accountEvents } from '../schema/realtime';

/**
 * The per-account realtime log (`db/schema/realtime.ts`, `docs/realtime.mdx`) and the unread count,
 * on a real Postgres: numbers are 1, 2, 3… per account in commit order even when appends race, a
 * client catches up from its cursor, and one that fell out of the log is told so.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const account = () => `user-${randomUUID()}`;

describe('the account log', () => {
  it('numbers each account on its own, from one', async () => {
    const a = account();
    const b = account();
    expect((await appendAccountEvent(db, a, 'credits', {})).seq).toBe(1);
    expect((await appendAccountEvent(db, a, 'credits', {})).seq).toBe(2);
    expect((await appendAccountEvent(db, b, 'gemies', { agentId: 'x' })).seq).toBe(1);
    expect(await accountEventHead(db, a)).toBe(2);
    expect(await accountEventHead(db, account())).toBe(0);
  });

  it('keeps the numbers contiguous when fifty appends race', async () => {
    const a = account();
    const seqs = await Promise.all(
      Array.from({ length: 50 }, (_, i) => appendAccountEvent(db, a, 'credits', { i })),
    );
    expect(seqs.map((event) => event.seq).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    const { events, gap, head } = await accountEventsSince(db, a, 0, 500);
    expect(gap).toBe(false);
    expect(head).toBe(50);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('replays what came after a cursor, in order, with each body as it was written', async () => {
    const a = account();
    for (const id of ['c1', 'c2', 'c3', 'c4'])
      await appendAccountEvent(db, a, 'conversation.deleted', { conversationId: id });
    const { events, gap, head } = await accountEventsSince(db, a, 2, 500);
    expect(gap).toBe(false);
    expect(head).toBe(4);
    expect(events.map((event) => [event.seq, event.type, event.data])).toEqual([
      [3, 'conversation.deleted', { conversationId: 'c3' }],
      [4, 'conversation.deleted', { conversationId: 'c4' }],
    ]);
    expect(await accountEventsSince(db, a, 4, 500)).toMatchObject({ events: [], gap: false });
  });

  it('says a client is too far behind: swept, beyond the replay limit, or ahead of the log', async () => {
    const a = account();
    for (let i = 0; i < 5; i++) await appendAccountEvent(db, a, 'credits', {});
    expect(await accountEventsSince(db, a, 1, 3)).toMatchObject({ gap: true, events: [] });
    await db.execute(
      sql`delete from ${accountEvents} where ${accountEvents.oxyUserId} = ${a} and ${accountEvents.seq} <= 2`,
    );
    expect(await accountEventsSince(db, a, 1, 500)).toMatchObject({ gap: true });
    expect(await accountEventsSince(db, a, 2, 500)).toMatchObject({ gap: false });
    expect(await accountEventsSince(db, a, 9, 500)).toMatchObject({ gap: true, head: 5 });
  });

  it('never reuses a number after the events behind it were swept', async () => {
    const a = account();
    await appendAccountEvent(db, a, 'credits', {});
    await db.execute(sql`delete from ${accountEvents} where ${accountEvents.oxyUserId} = ${a}`);
    expect((await appendAccountEvent(db, a, 'credits', {})).seq).toBe(2);
  });
});

describe('the unread count', () => {
  it('counts what arrived unwatched, per conversation and per gemie thread, and reading zeroes it', async () => {
    const a = account();
    const base = { oxyUserId: a, titleOnInsert: 'x', agentId: 'pepe' };
    await upsertConversation(db, { ...base, conversationId: 'c1', lastMessage: 'hola', unread: 1 });
    await upsertConversation(db, { ...base, conversationId: 'c1', lastMessage: 'otra', unread: 1 });
    await upsertConversation(db, { ...base, conversationId: 'c2', lastMessage: 'y', unread: 1 });
    // The person's own turn: nothing unread.
    await upsertConversation(db, { ...base, conversationId: 'c3', lastMessage: 'mine' });
    expect((await findConversation(db, a, 'c1'))?.unreadCount).toBe(2);
    expect((await findConversation(db, a, 'c3'))?.unreadCount).toBe(0);
    expect(await unreadPerAgent(db, a, ['pepe', 'nobody'])).toEqual(new Map([['pepe', 3]]));

    const before = (await findConversation(db, a, 'c1'))?.updatedAt;
    expect(await markConversationRead(db, a, 'c1')).toBe(true);
    const after = await findConversation(db, a, 'c1');
    expect(after?.unreadCount).toBe(0);
    // Reading is not activity: the list's order does not move.
    expect(after?.updatedAt.getTime()).toBe(before?.getTime());
    expect(await unreadPerAgent(db, a, ['pepe'])).toEqual(new Map([['pepe', 1]]));
    expect(await markConversationRead(db, account(), 'c1')).toBe(false);
  });
});
