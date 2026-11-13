/**
 * THE realtime connection of one signed-in account to one Gemies API (`docs/realtime.mdx`).
 *
 * One Socket.IO connection per (API, account), however many screens listen: they share it through
 * {@link acquireRealtime} and the last to release closes it. It:
 *
 * - authenticates every (re)connect with a fresh token of the API's own linked Oxy client;
 * - reconnects with jittered backoff (Socket.IO's own), and after the server REFUSES a handshake —
 *   which Socket.IO does not retry — tries again on a doubling delay up to a minute;
 * - keeps the account's event cursor, and on every connect asks `rt:sync` for what came after it:
 *   missed events are replayed in order, a client too far behind is told to reload (`reset`);
 * - drops a durable frame it already applied, and treats a frame that skips a number as a gap to
 *   fill from `rt:sync`, so an event is applied once and in order;
 * - re-subscribes the topics its holders follow after every reconnect.
 */

import { io, type Socket } from 'socket.io-client';
import {
  REALTIME_EVENT,
  REALTIME_SUBSCRIBE,
  REALTIME_SYNC,
  REALTIME_UNSUBSCRIBE,
  readFrame,
  type RealtimeFrame,
  type RealtimeSyncReply,
  type RealtimeType,
} from './contract';

/** A holder's way to the API's access token: asked on every (re)connect. */
export type RealtimeTokenSource = () => string | null | Promise<string | null>;

export type RealtimeListener = (frame: RealtimeFrame) => void;

/** After a refused handshake: the first wait, doubled up to the second. */
export const REFUSED_RETRY_MS = 5_000;
export const REFUSED_RETRY_MAX_MS = 60_000;
/** How many applied durable frames are kept to re-apply over a snapshot that predates them. */
const REPLAY_BUFFER = 256;

export interface RealtimeConnection {
  /** Listen for one type, or every frame (`'*'`). Returns the unsubscribe. */
  on(type: RealtimeType | '*', listener: RealtimeListener): () => void;
  /** Called when the client must reload what it shows (its cursor fell out of the log). */
  onReset(listener: () => void): () => void;
  /** Called when the connection comes up or goes down. Returns the unsubscribe. */
  onStatus(listener: (connected: boolean) => void): () => void;
  /**
   * A device's own protocol on the same connection, outside the `rt` frames: the local model
   * runtime's offer (`subscribe-user-runtime`) and the requests the server sends it. Dropped while
   * disconnected; a protocol re-sends what it must from `onStatus`.
   */
  send(event: string, payload?: unknown): void;
  /** Hear one of those protocol events. Returns the unsubscribe. */
  listen(event: string, handler: (payload: unknown) => void): () => void;
  /** Follow a topic while held; re-subscribed after every reconnect. Returns the release. */
  follow(topic: string): () => void;
  /**
   * An HTTP read that carried the account's cursor (`realtimeSeq`). Events after it that this
   * connection already applied are applied again, after the read's data is in the cache, so a
   * response that left before an event arrived cannot put the older state back.
   */
  noteSnapshot(seq: number): void;
  readonly connected: boolean;
}

interface Internal extends RealtimeConnection {
  socket: Socket;
  refs: number;
  tokens: Map<symbol, RealtimeTokenSource>;
  close(): void;
}

function open(url: string): Internal {
  const tokens = new Map<symbol, RealtimeTokenSource>();
  const listeners = new Map<string, Set<RealtimeListener>>();
  const resetListeners = new Set<() => void>();
  const statusListeners = new Set<(connected: boolean) => void>();
  const status = (connected: boolean): void => {
    for (const listener of [...statusListeners]) listener(connected);
  };
  const topics = new Map<string, number>();
  /** The last durable number applied; `null` until the first sync answered. */
  let cursor: number | null = null;
  /** The lowest snapshot seen before the first sync: where catch-up starts. */
  let floor: number | null = null;
  let syncing = false;
  let resyncWanted = false;
  const queued: RealtimeFrame[] = [];
  const applied: RealtimeFrame[] = [];
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryMs = REFUSED_RETRY_MS;

  const socket = io(url, {
    transports: ['websocket'],
    auth: (cb) => {
      const source = [...tokens.values()].at(-1);
      // A source that throws is a handshake without a token, never a crash of the caller.
      new Promise<string | null>((resolve) => resolve(source ? source() : null)).then(
        (token) => cb(token ? { token } : {}),
        () => cb({}),
      );
    },
    reconnection: true,
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.5,
  });

  const dispatch = (frame: RealtimeFrame): void => {
    for (const key of [frame.type, '*']) {
      const set = listeners.get(key);
      if (!set) continue;
      for (const listener of [...set]) {
        try {
          listener(frame);
        } catch {
          // One listener's failure is its own; the others still hear the frame.
        }
      }
    }
  };

  const applyDurable = (frame: RealtimeFrame): void => {
    const seq = frame.seq as number;
    if (cursor !== null && seq <= cursor) return;
    if (cursor !== null && seq > cursor + 1) {
      // A number was skipped: fetch the gap, which replays this frame too, in order.
      sync();
      return;
    }
    cursor = seq;
    applied.push(frame);
    if (applied.length > REPLAY_BUFFER) applied.shift();
    dispatch(frame);
  };

  const sync = (): void => {
    if (!socket.connected) return;
    if (syncing) {
      resyncWanted = true;
      return;
    }
    syncing = true;
    const since = cursor ?? floor;
    socket.emit(REALTIME_SYNC, { since }, (reply: RealtimeSyncReply) => {
      syncing = false;
      if (reply && typeof reply.head === 'number' && reply.head >= 0) {
        if (reply.reset) {
          cursor = reply.head;
          applied.length = 0;
          for (const listener of [...resetListeners]) listener();
        } else {
          if (cursor === null) cursor = since ?? reply.head;
          for (const event of reply.events ?? []) {
            const frame = readFrame(event);
            if (frame?.seq !== undefined) applyDurable(frame);
          }
          if (cursor < reply.head && (reply.events?.length ?? 0) === 0) cursor = reply.head;
        }
      }
      const pending = queued.splice(0);
      for (const frame of pending) applyDurable(frame);
      if (resyncWanted) {
        resyncWanted = false;
        sync();
      }
    });
  };

  socket.on('connect', () => {
    retryMs = REFUSED_RETRY_MS;
    sync();
    for (const topic of topics.keys()) socket.emit(REALTIME_SUBSCRIBE, { topic });
    status(true);
  });
  socket.on('disconnect', () => status(false));
  socket.on('connect_error', () => {
    // A refused handshake (no token yet, an expired one) ends Socket.IO's own retrying.
    if (socket.active || retry !== null) return;
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, REFUSED_RETRY_MAX_MS);
    retry = setTimeout(() => {
      retry = null;
      socket.connect();
    }, wait);
  });
  socket.on(REALTIME_EVENT, (value: unknown) => {
    const frame = readFrame(value);
    if (!frame) return;
    if (frame.seq === undefined) {
      dispatch(frame);
      return;
    }
    if (cursor === null || syncing) {
      queued.push(frame);
      return;
    }
    applyDurable(frame);
  });

  return {
    socket,
    refs: 0,
    tokens,
    get connected() {
      return socket.connected;
    },
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return () => {
        listeners.get(type)?.delete(listener);
      };
    },
    onReset(listener) {
      resetListeners.add(listener);
      return () => {
        resetListeners.delete(listener);
      };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    send(event, payload) {
      if (socket.connected) socket.emit(event, payload);
    },
    listen(event, handler) {
      socket.on(event, handler);
      return () => {
        socket.off(event, handler);
      };
    },
    follow(topic) {
      const held = topics.get(topic) ?? 0;
      topics.set(topic, held + 1);
      if (held === 0 && socket.connected) socket.emit(REALTIME_SUBSCRIBE, { topic });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (topics.get(topic) ?? 1) - 1;
        if (left > 0) {
          topics.set(topic, left);
          return;
        }
        topics.delete(topic);
        if (socket.connected) socket.emit(REALTIME_UNSUBSCRIBE, { topic });
      };
    },
    noteSnapshot(seq) {
      if (!Number.isSafeInteger(seq) || seq < 0) return;
      if (cursor === null) {
        floor = floor === null ? seq : Math.min(floor, seq);
        return;
      }
      if (seq >= cursor) return;
      const newer = applied.filter((frame) => (frame.seq as number) > seq);
      if (newer.length === 0) return;
      // After the read's data has been written: re-apply what it predates.
      setTimeout(() => {
        for (const frame of newer) dispatch(frame);
      }, 0);
    },
    close() {
      if (retry !== null) clearTimeout(retry);
      socket.removeAllListeners();
      socket.disconnect();
      listeners.clear();
      resetListeners.clear();
      statusListeners.clear();
    },
  };
}

const connections = new Map<string, Internal>();

/**
 * Hold the realtime connection of `account` to `url`, opening it on the first hold. The token
 * source is the holder's; the connection asks the latest one still held. Returns the connection and
 * its release: the last release closes it.
 */
export function acquireRealtime(
  url: string,
  account: string,
  token: RealtimeTokenSource,
): { connection: RealtimeConnection; release: () => void } {
  const key = `${url}|${account}`;
  let held = connections.get(key);
  if (!held) {
    held = open(url);
    connections.set(key, held);
  }
  const connection = held;
  const holder = Symbol('realtime-holder');
  connection.tokens.set(holder, token);
  connection.refs++;
  let released = false;
  return {
    connection,
    release: () => {
      if (released) return;
      released = true;
      connection.tokens.delete(holder);
      if (--connection.refs > 0) return;
      connections.delete(key);
      connection.close();
    },
  };
}
