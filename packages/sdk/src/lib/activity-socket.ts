import { io, type Socket } from 'socket.io-client';
import type { GemieAvatarState } from '../components/GemieAvatar';
import { useGemieActivityStore } from './activity-store';

/** A run that goes quiet this long is over: a crashed run never says `idle`. */
export const ACTIVITY_QUIET_MS = 90_000;
/**
 * After the server refuses a handshake (socket.io does not retry those itself), wait this long,
 * doubling up to {@link MAX_RETRY_MS}. A fixed 5 s retry with a token that could never pass (the
 * session's base token after it expired) opened a websocket every few seconds for as long as the
 * tab stayed open: 51 upgrades in 12 minutes for one person, on top of their API budget.
 */
export const RETRY_MS = 5_000;
export const MAX_RETRY_MS = 60_000;

/** A holder's way to the API's access token: fresh on every call (a linked client's). */
export type ActivityTokenSource = () => string | null | Promise<string | null>;

const STATES: ReadonlySet<string> = new Set<GemieAvatarState>([
  'idle',
  'thinking',
  'working',
  'writing',
]);

interface Connection {
  socket: Socket;
  refs: number;
  quiet: Map<string, ReturnType<typeof setTimeout>>;
  retry: ReturnType<typeof setTimeout> | null;
  retryMs: number;
  /** Each holder's token source; the socket asks the latest one still held. */
  tokens: Map<symbol, ActivityTokenSource>;
}

/** One connection per API origin, however many buttons ask for it. */
const connections = new Map<string, Connection>();

function open(url: string): Connection {
  const tokens = new Map<symbol, ActivityTokenSource>();
  const socket = io(url, {
    transports: ['websocket'],
    // Asked on every (re)connect, of a holder still holding it, so the token that goes out is a
    // current one: never a captured one, never one whose holder has gone.
    auth: (cb) => {
      const source = [...tokens.values()].at(-1);
      Promise.resolve(source ? source() : null).then(
        (token) => cb({ token }),
        () => cb({}),
      );
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  const connection: Connection = {
    socket,
    refs: 0,
    quiet: new Map(),
    retry: null,
    retryMs: RETRY_MS,
    tokens,
  };
  const store = useGemieActivityStore.getState;

  const reset = (): void => {
    for (const timer of connection.quiet.values()) clearTimeout(timer);
    connection.quiet.clear();
    store().clearRemote();
  };

  socket.on('connect', () => {
    connection.retryMs = RETRY_MS;
    socket.emit('subscribe-alia-activity');
  });
  // What happened while disconnected is unknown; a stale "working" is worse than idle.
  socket.on('disconnect', reset);
  socket.on('connect_error', () => {
    // A refused handshake (no token yet, an expired one) ends the socket's own retrying.
    if (socket.active || connection.retry !== null) return;
    const wait = connection.retryMs;
    connection.retryMs = Math.min(wait * 2, MAX_RETRY_MS);
    connection.retry = setTimeout(() => {
      connection.retry = null;
      socket.connect();
    }, wait);
  });
  socket.on('alia:activity', (event: unknown) => {
    if (typeof event !== 'object' || event === null) return;
    const { state, sessionId } = event as { state?: unknown; sessionId?: unknown };
    if (typeof sessionId !== 'string' || typeof state !== 'string' || !STATES.has(state)) return;
    const pending = connection.quiet.get(sessionId);
    if (pending !== undefined) clearTimeout(pending);
    connection.quiet.delete(sessionId);
    store().setRemote(sessionId, state as GemieAvatarState);
    if (state !== 'idle') {
      connection.quiet.set(
        sessionId,
        setTimeout(() => {
          connection.quiet.delete(sessionId);
          store().setRemote(sessionId, 'idle');
        }, ACTIVITY_QUIET_MS),
      );
    }
  });
  return connection;
}

/**
 * Listen for Alia's activity on the person's behalf. Every caller shares the one connection for
 * `url`; the last to release closes it. Returns the release.
 */
export function acquireActivitySocket(url: string, getToken: ActivityTokenSource): () => void {
  let held = connections.get(url);
  if (!held) {
    held = open(url);
    connections.set(url, held);
  }
  const connection = held;
  const holder = Symbol('activity-holder');
  connection.tokens.set(holder, getToken);
  connection.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    connection.tokens.delete(holder);
    if (--connection.refs > 0) return;
    connections.delete(url);
    if (connection.retry !== null) clearTimeout(connection.retry);
    connection.socket.removeAllListeners();
    connection.socket.disconnect();
    for (const timer of connection.quiet.values()) clearTimeout(timer);
    useGemieActivityStore.getState().clearRemote();
  };
}
