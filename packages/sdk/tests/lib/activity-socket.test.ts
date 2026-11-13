import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;
interface FakeSocket {
  url: string;
  options: { auth: (cb: (a: unknown) => void) => void };
  handlers: Map<string, Handler>;
  active: boolean;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}
const mocks = vi.hoisted(() => ({ sockets: [] as unknown[] }));
const sockets = () => mocks.sockets as FakeSocket[];

vi.mock('socket.io-client', () => ({
  io: (url: string, options: unknown) => {
    const handlers = new Map<string, Handler>();
    const socket = {
      url,
      options,
      handlers,
      active: true,
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      emit: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      removeAllListeners: vi.fn(() => handlers.clear()),
    };
    mocks.sockets.push(socket);
    return socket;
  },
}));

import {
  ACTIVITY_QUIET_MS,
  MAX_RETRY_MS,
  RETRY_MS,
  acquireActivitySocket,
} from '../../src/lib/activity-socket';
import { selectGemieActivity, useGemieActivityStore } from '../../src/lib/activity-store';

const now = () => selectGemieActivity(useGemieActivityStore.getState());
const fire = (event: string, ...args: unknown[]) =>
  sockets().at(-1)?.handlers.get(event)?.(...args);

describe('activity socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sockets.length = 0;
    useGemieActivityStore.setState({ local: {}, remote: {} });
  });
  afterEach(() => vi.useRealTimers());

  it('connects once for any number of holders, subscribes on connect, and closes with the last', () => {
    const releaseA = acquireActivitySocket('https://api.test', () => 't1');
    const releaseB = acquireActivitySocket('https://api.test', () => 't1');
    expect(sockets()).toHaveLength(1);

    fire('connect');
    expect(sockets()[0].emit).toHaveBeenCalledWith('subscribe-alia-activity');

    releaseA();
    releaseA();
    expect(sockets()[0].disconnect).not.toHaveBeenCalled();
    releaseB();
    expect(sockets()[0].disconnect).toHaveBeenCalledTimes(1);

    // A later holder opens a fresh connection.
    const releaseC = acquireActivitySocket('https://api.test', () => 't1');
    expect(sockets()).toHaveLength(2);
    releaseC();
  });

  it('asks for a token at every handshake, of a holder still holding it', async () => {
    let token = 'first';
    const releaseA = acquireActivitySocket('https://api.test', () => token);
    const releaseB = acquireActivitySocket('https://api.test', async () => 'from-b');
    const seen: unknown[] = [];
    const handshake = async () => {
      sockets()[0].options.auth((a) => seen.push(a));
      await vi.runAllTimersAsync();
    };
    await handshake();
    releaseB();
    await handshake();
    token = 'rotated';
    await handshake();
    expect(seen).toEqual([{ token: 'from-b' }, { token: 'first' }, { token: 'rotated' }]);
    releaseA();
  });

  it('hands the server no token, rather than a stale one, when the source fails', async () => {
    const release = acquireActivitySocket('https://api.test', async () => {
      throw new Error('no session');
    });
    const seen: unknown[] = [];
    sockets()[0].options.auth((a) => seen.push(a));
    await vi.runAllTimersAsync();
    expect(seen).toEqual([{}]);
    release();
  });

  it('maps server events to states per session, ignoring malformed ones', () => {
    const release = acquireActivitySocket('https://api.test', () => 't');
    fire('alia:activity', { state: 'thinking', sessionId: 's1' });
    expect(now()).toBe('thinking');
    fire('alia:activity', { state: 'working', sessionId: 's2' });
    expect(now()).toBe('working');
    fire('alia:activity', { state: 'idle', sessionId: 's2' });
    expect(now()).toBe('thinking');
    fire('alia:activity', { state: 'bogus', sessionId: 's1' });
    fire('alia:activity', null);
    fire('alia:activity', { state: 'writing' });
    expect(now()).toBe('thinking');
    fire('alia:activity', { state: 'idle', sessionId: 's1' });
    expect(now()).toBe('idle');
    release();
  });

  it('forgets a run that goes quiet, and every run when the connection drops or closes', () => {
    const release = acquireActivitySocket('https://api.test', () => 't');
    fire('alia:activity', { state: 'working', sessionId: 's1' });
    vi.advanceTimersByTime(ACTIVITY_QUIET_MS + 1);
    expect(now()).toBe('idle');

    fire('alia:activity', { state: 'working', sessionId: 's1' });
    fire('disconnect');
    expect(now()).toBe('idle');

    fire('alia:activity', { state: 'working', sessionId: 's1' });
    release();
    expect(now()).toBe('idle');
  });

  it('keeps local turns when the socket closes', () => {
    const release = acquireActivitySocket('https://api.test', () => 't');
    useGemieActivityStore.getState().setLocal('sheet', 'writing');
    release();
    expect(now()).toBe('writing');
  });

  it('retries a refused handshake itself, backing off to a minute, and resets once connected', () => {
    const release = acquireActivitySocket('https://api.test', () => null);
    const socket = sockets()[0];
    socket.active = false;
    const refuseAndWait = (ms: number) => {
      fire('connect_error');
      fire('connect_error'); // a second refusal while one retry is pending schedules nothing
      vi.advanceTimersByTime(ms);
    };
    // 5 s, 10 s, 20 s, 40 s, then a minute at most: never a socket every few seconds.
    const waits = [RETRY_MS, 10_000, 20_000, 40_000, MAX_RETRY_MS, MAX_RETRY_MS];
    waits.forEach((wait, i) => {
      refuseAndWait(wait - 1);
      expect(socket.connect).toHaveBeenCalledTimes(i);
      vi.advanceTimersByTime(1);
      expect(socket.connect).toHaveBeenCalledTimes(i + 1);
    });
    // Over ten minutes of refusals, at most about one attempt a minute.
    socket.connect.mockClear();
    for (let t = 0; t < 10; t++) refuseAndWait(MAX_RETRY_MS);
    expect(socket.connect.mock.calls.length).toBeLessThanOrEqual(10);
    // A successful connection starts the next outage from 5 s again.
    fire('connect');
    socket.connect.mockClear();
    refuseAndWait(RETRY_MS);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    release();
  });
});
