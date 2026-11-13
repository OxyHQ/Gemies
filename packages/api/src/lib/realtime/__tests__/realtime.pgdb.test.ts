import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Two devices of one person on the real realtime server (`socket.ts`, `lib/realtime`), over a real
 * Postgres: a message one of them did not send reaches both, with the sidebar row and the unread
 * count, within a bound; "typing…" reaches both; nothing reaches another account; and a device that
 * was away catches up from its cursor with exactly what it missed, in order, without a duplicate.
 */

// The handshake's identity, without Oxy: the token IS the user id here.
vi.mock('../../oxy.js', () => ({
  oxy: {
    middleware: {
      socket:
        () =>
        (
          socket: { handshake: { auth?: { token?: string } }; data: Record<string, unknown> },
          next: (err?: Error) => void,
        ) => {
          const token = socket.handshake.auth?.token;
          if (!token) return next(new Error('unauthorized'));
          socket.data.userId = token;
          socket.data.token = token;
          next();
        },
    },
  },
}));
// One task: the in-memory adapter (the Redis adapter's fan-out is `socketRedisAdapter.test.ts`).
vi.mock('../../redis.js', () => ({ getRedisClient: () => null, getRedisSubClient: () => null }));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index';
import { insertMessages } from '../../../db/chat/messageRepository';
import { upsertConversation } from '../../../db/chat/conversationRepository';
import { initSocket } from '../../../socket.js';
import { startActorActivity } from '../activity.js';
import { publishConversation } from '../conversations.js';
import type { RealtimeFrame, RealtimeSyncReply } from '../contract.js';

/** How long a frame may take from the publish to both devices. */
const BOUND_MS = 1_000;

let db: ApiDatabase;
let server: http.Server;
let url: string;
let closeIo: () => Promise<void>;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
  server = http.createServer();
  const io = initSocket(server);
  closeIo = () => new Promise((resolve) => io.close(() => resolve()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const client of clients) client.disconnect();
  await closeIo();
  await closePostgres();
});

/** A device: connected, caught up, and recording every frame it receives. */
async function device(userId: string) {
  const socket = connect(url, {
    transports: ['websocket'],
    auth: { token: userId },
    forceNew: true,
  });
  clients.push(socket);
  const frames: RealtimeFrame[] = [];
  socket.on('rt', (frame: RealtimeFrame) => frames.push(frame));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const head = (await socket.emitWithAck('rt:sync', { since: null })) as RealtimeSyncReply;
  return { socket, frames, cursor: head.head };
}

const until = async (check: () => boolean, bound = BOUND_MS) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > bound) throw new Error(`not within ${bound} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Date.now() - started;
};

/** A gemie writes into the person's conversation on its own, as outreach does. */
async function gemieWrites(userId: string, conversationId: string, seq: number, text: string) {
  await insertMessages(db, [
    {
      conversationId,
      oxyUserId: userId,
      clientMessageId: `m-${seq}`,
      role: 'assistant',
      content: text,
      seq,
      createdAt: new Date(),
    },
  ]);
  await upsertConversation(db, {
    oxyUserId: userId,
    conversationId,
    lastMessage: text,
    titleOnInsert: 'Pepe',
    agentId: 'pepe',
    unread: 1,
  });
  await publishConversation(userId, conversationId, { appendedFromSeq: seq });
}

describe('two devices of one person', () => {
  it('both see a new message, its sidebar row and its unread count, and nobody else does', async () => {
    const person = `person-${Date.now()}`;
    const phone = await device(person);
    const laptop = await device(person);
    const stranger = await device(`stranger-${Date.now()}`);

    await gemieWrites(person, 'c1', 0, 'Hola, ¿qué tal?');
    const took = await until(() =>
      [phone, laptop].every((d) => d.frames.some((f) => f.type === 'conversation')),
    );
    expect(took).toBeLessThan(BOUND_MS);
    for (const d of [phone, laptop]) {
      const frame = d.frames.find((f) => f.type === 'conversation');
      expect(frame?.seq).toBe(1);
      expect(frame?.data).toMatchObject({
        conversation: { id: 'c1', lastMessage: 'Hola, ¿qué tal?', unreadCount: 1, agentId: 'pepe' },
        thread: { agentId: 'pepe', unreadCount: 1 },
        appended: [{ id: 'm-0', role: 'assistant', content: 'Hola, ¿qué tal?' }],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stranger.frames).toEqual([]);
  });

  it('both see "Pepe is typing…", and it ends', async () => {
    const person = `person-typing-${Date.now()}`;
    const phone = await device(person);
    const laptop = await device(person);
    const activity = startActorActivity({
      oxyUserId: person,
      conversationId: 'c1',
      agentId: 'pepe',
      name: 'Pepe',
    });
    activity.set('writing');
    const states = (d: { frames: RealtimeFrame[] }) =>
      d.frames.filter((f) => f.type === 'activity').map((f) => (f.data as { state: string }).state);
    await until(() => [phone, laptop].every((d) => states(d).includes('writing')));
    activity.end();
    await until(() => [phone, laptop].every((d) => states(d).at(-1) === 'idle'));
    expect(phone.frames.find((f) => f.type === 'activity')).toMatchObject({
      data: { conversationId: 'c1', actor: { agentId: 'pepe', name: 'Pepe' } },
    });
    // A signal is never numbered: it is not replayed.
    expect(
      phone.frames.filter((f) => f.type === 'activity').every((f) => f.seq === undefined),
    ).toBe(true);
  });

  it('a device that was away catches up with exactly what it missed, in order, once', async () => {
    const person = `person-away-${Date.now()}`;
    const phone = await device(person);
    const laptop = await device(person);

    await gemieWrites(person, 'c1', 0, 'uno');
    await until(() => laptop.frames.some((f) => f.seq === 1));
    const cursor = 1;
    laptop.socket.disconnect();

    await gemieWrites(person, 'c1', 1, 'dos');
    await gemieWrites(person, 'c1', 2, 'tres');
    await gemieWrites(person, 'c2', 0, 'cuatro');
    await until(() => phone.frames.filter((f) => f.seq !== undefined).length === 4);

    // Back: it asks for what came after the last number it applied.
    laptop.socket.connect();
    await until(() => laptop.socket.connected);
    const reply = (await laptop.socket.emitWithAck('rt:sync', {
      since: cursor,
    })) as RealtimeSyncReply;
    expect(reply.reset).toBeUndefined();
    expect(reply.head).toBe(4);
    expect(reply.events?.map((f) => f.seq)).toEqual([2, 3, 4]);
    expect(
      reply.events?.map(
        (f) => (f.data as { appended: { content: string }[] }).appended.map((m) => m.content)[0],
      ),
    ).toEqual(['dos', 'tres', 'cuatro']);
    // The row's unread count, as it stands after each: two in c1, then one in c2.
    expect(
      reply.events?.map(
        (f) => (f.data as { conversation: { unreadCount: number } }).conversation.unreadCount,
      ),
    ).toEqual([2, 3, 1]);

    // What it had applied before going away is not sent again; nothing arrives twice.
    const applied = new Set<number>([1]);
    for (const event of reply.events ?? []) {
      expect(applied.has(event.seq as number)).toBe(false);
      applied.add(event.seq as number);
    }
  });

  it('a device whose cursor fell out of the log is told to reload', async () => {
    const person = `person-reset-${Date.now()}`;
    const phone = await device(person);
    await gemieWrites(person, 'c1', 0, 'uno');
    const reply = (await phone.socket.emitWithAck('rt:sync', { since: 40 })) as RealtimeSyncReply;
    expect(reply).toEqual({ head: 1, reset: true });
  });
});
