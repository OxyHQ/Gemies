import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The account's one realtime connection (`src/realtime/connection.ts`) over a fake Socket.IO
 * client: shared per API and account, caught up from its cursor on every connect, applying each
 * durable event once and in order, filling a skipped number, reloading when told to, and following
 * its topics again after a reconnect.
 */

type Handler = (...args: unknown[]) => void;
interface FakeSocket {
  connected: boolean;
  active: boolean;
  handlers: Map<string, Handler[]>;
  emitted: { event: string; payload: unknown; ack?: Handler }[];
  on(event: string, handler: Handler): FakeSocket;
  emit(event: string, payload?: unknown, ack?: Handler): FakeSocket;
  connect(): FakeSocket;
  disconnect(): FakeSocket;
  removeAllListeners(): FakeSocket;
  fire(event: string, ...args: unknown[]): void;
}

const sockets = vi.hoisted(() => [] as unknown[]);

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const socket: FakeSocket = {
      connected: false,
      active: true,
      handlers: new Map(),
      emitted: [],
      on(event, handler) {
        socket.handlers.set(event, [...(socket.handlers.get(event) ?? []), handler]);
        return socket;
      },
      emit(event, payload, ack) {
        socket.emitted.push({ event, payload, ...(ack ? { ack } : {}) });
        return socket;
      },
      connect() {
        return socket;
      },
      disconnect() {
        socket.connected = false;
        return socket;
      },
      removeAllListeners() {
        socket.handlers.clear();
        return socket;
      },
      fire(event, ...args) {
        for (const handler of socket.handlers.get(event) ?? []) handler(...args);
      },
    };
    sockets.push(socket);
    return socket;
  }),
}));

import { acquireRealtime } from '../../src/realtime/connection';
import type { RealtimeFrame } from '../../src/realtime/contract';

const latest = () => sockets.at(-1) as FakeSocket;
const token = () => 'token';
const frame = (seq: number, id = `c${seq}`): RealtimeFrame =>
  ({ v: 1, type: 'conversation.deleted', data: { conversationId: id }, seq }) as RealtimeFrame;

/** Bring the socket up and answer its first `rt:sync` with `reply`. */
function connect(socket: FakeSocket, reply: Record<string, unknown>): void {
  socket.connected = true;
  socket.fire('connect');
  const sync = [...socket.emitted].reverse().find((e) => e.event === 'rt:sync');
  sync?.ack?.(reply);
}

let releases: (() => void)[] = [];
beforeEach(() => {
  sockets.length = 0;
  releases = [];
});
afterEach(() => {
  for (const release of releases) release();
});

function hold(account = 'u1') {
  const held = acquireRealtime('https://api.test', account, token);
  releases.push(held.release);
  return held.connection;
}

describe('the account connection', () => {
  it('is one socket per API and account, closed by the last holder', () => {
    const a = acquireRealtime('https://api.test', 'u1', token);
    const b = acquireRealtime('https://api.test', 'u1', token);
    expect(sockets).toHaveLength(1);
    expect(a.connection).toBe(b.connection);
    acquireRealtime('https://api.test', 'u2', token).release();
    expect(sockets).toHaveLength(2);
    const socket = sockets[0] as FakeSocket;
    socket.connected = true;
    a.release();
    expect(socket.connected).toBe(true);
    b.release();
    expect(socket.connected).toBe(false);
  });

  it('starts from the head, applies each event once and in order', () => {
    const connection = hold();
    const seen: number[] = [];
    connection.on('*', (f) => seen.push(f.seq ?? -1));
    connect(latest(), { head: 10 });
    expect(latest().emitted[0]).toMatchObject({ event: 'rt:sync', payload: { since: null } });
    latest().fire('rt', frame(11));
    latest().fire('rt', frame(11));
    latest().fire('rt', frame(10));
    latest().fire('rt', frame(12));
    expect(seen).toEqual([11, 12]);
  });

  it('fills a skipped number from the log, without doubling what arrived', () => {
    const connection = hold();
    const seen: number[] = [];
    connection.on('*', (f) => seen.push(f.seq ?? -1));
    connect(latest(), { head: 5 });
    latest().fire('rt', frame(7));
    const sync = latest()
      .emitted.filter((e) => e.event === 'rt:sync')
      .at(-1);
    expect(sync?.payload).toEqual({ since: 5 });
    sync?.ack?.({ head: 7, events: [frame(6), frame(7)] });
    latest().fire('rt', frame(7));
    expect(seen).toEqual([6, 7]);
  });

  it('catches up after a reconnect from its cursor, and follows its topics again', () => {
    const connection = hold();
    const seen: number[] = [];
    connection.on('*', (f) => seen.push(f.seq ?? -1));
    connection.follow('agent-session:s1');
    connect(latest(), { head: 3 });
    expect(latest().emitted.some((e) => e.event === 'rt:subscribe')).toBe(true);
    latest().fire('disconnect');
    latest().emitted.length = 0;
    connect(latest(), { head: 5, events: [frame(4), frame(5)] });
    expect(latest().emitted[0]).toMatchObject({ event: 'rt:sync', payload: { since: 3 } });
    expect(latest().emitted).toContainEqual({
      event: 'rt:subscribe',
      payload: { topic: 'agent-session:s1' },
    });
    expect(seen).toEqual([4, 5]);
  });

  it('asks the client to reload when its cursor fell out of the log', () => {
    const connection = hold();
    const reset = vi.fn();
    connection.onReset(reset);
    connect(latest(), { head: 2 });
    latest().fire('disconnect');
    connect(latest(), { head: 900, reset: true });
    expect(reset).toHaveBeenCalledOnce();
    const seen: number[] = [];
    connection.on('*', (f) => seen.push(f.seq ?? -1));
    latest().fire('rt', frame(901));
    expect(seen).toEqual([901]);
  });

  it('starts from the oldest snapshot a read carried, so nothing behind it is lost', () => {
    const connection = hold();
    connection.noteSnapshot(40);
    connection.noteSnapshot(38);
    connect(latest(), { head: 41, events: [frame(39), frame(40), frame(41)] });
    expect(latest().emitted[0]).toMatchObject({ payload: { since: 38 } });
  });

  it('holds frames that arrive before the first catch-up answered', () => {
    const connection = hold();
    const seen: number[] = [];
    connection.on('*', (f) => seen.push(f.seq ?? -1));
    const socket = latest();
    socket.connected = true;
    socket.fire('connect');
    socket.fire('rt', frame(21));
    expect(seen).toEqual([]);
    socket.emitted.find((e) => e.event === 'rt:sync')?.ack?.({ head: 20 });
    expect(seen).toEqual([21]);
  });

  it('passes signals straight through and skips frames it does not know', () => {
    const connection = hold();
    const types: string[] = [];
    connection.on('*', (f) => types.push(f.type));
    connect(latest(), { head: 0 });
    latest().fire('rt', { v: 1, type: 'activity', data: {} });
    latest().fire('rt', { v: 1, type: 'from.the.future', data: {} });
    latest().fire('rt', { v: 2, type: 'activity', data: {} });
    expect(types).toEqual(['activity']);
  });

  it('retries a refused handshake on a doubling delay', () => {
    vi.useFakeTimers();
    try {
      hold();
      const socket = latest();
      const connect = vi.spyOn(socket, 'connect');
      socket.active = false;
      socket.fire('connect_error', new Error('refused'));
      vi.advanceTimersByTime(4_999);
      expect(connect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(connect).toHaveBeenCalledTimes(1);
      socket.fire('connect_error', new Error('refused'));
      vi.advanceTimersByTime(9_999);
      expect(connect).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
