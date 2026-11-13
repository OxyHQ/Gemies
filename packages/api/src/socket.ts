import { Server, type Socket } from 'socket.io';
import { createOxySocketCors } from '@oxy.so/core/server';
import { createAdapter } from '@socket.io/redis-adapter';
import type http from 'http';
import { getRedisClient, getRedisSubClient } from './lib/redis.js';
import { log } from './lib/logger.js';
import { oxy } from './lib/oxy.js';
import { appOriginsFor } from './lib/cors-origins.js';
import {
  deliverUserRuntimeMessage,
  userRuntimeRoom,
  type UserRuntimePresence,
} from './lib/inference/user-runtime-bridge.js';
import {
  accountRoom,
  bindRealtimeServer,
  signalAccount,
  signalTopic,
} from './lib/realtime/publish.js';
import { attachRealtimeHandlers } from './lib/realtime/socket-handlers.js';

/** Read the authenticated user id planted on the socket by `oxy.middleware.socket()`. */
function socketUserId(socket: Socket): string | null {
  const fromData = socket.data?.userId;
  if (typeof fromData === 'string' && fromData.length > 0) return fromData;
  return null;
}

/**
 * The bearer `oxy.middleware.socket()` verified, kept for the ONE gate that needs it.
 *
 * `socket.data.token` is the handshake token the middleware already validated,
 * so this reads a verified value rather than trusting the client — and it is
 * what lets a room gate ask Oxy the same `account:act_as` question an HTTP route
 * asks, instead of falling back to an ownership column that stopped being an
 * authorization answer.
 */
function socketAccessToken(socket: Socket): string | null {
  const token = socket.data?.token;
  if (typeof token === 'string' && token.length > 0) return token;
  return null;
}

/**
 * Validate a runtime offer before it is kept on the socket.
 *
 * The model list is capped: it is client-supplied, it is broadcast to the
 * person's other devices, and `fetchSockets()` carries it between tasks.
 */
function runtimeOffer(value: unknown): UserRuntimePresence | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, label, models } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  if (typeof label !== 'string' || label.length > 128) return null;
  if (!Array.isArray(models)) return null;
  const names = models.filter(
    (m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 200,
  );
  if (names.length === 0 || names.length > 200) return null;
  return { id, label, models: names };
}

let io: Server | null = null;

export function initSocket(server: http.Server) {
  io = new Server(server, {
    // The origins HTTP admits (`lib/cors-origins.ts`), on both transports:
    // `cors` for long-polling and `allowRequest` for the WebSocket handshake,
    // which browsers apply no CORS to. A native WebSocket (React Native,
    // OxyOS) sends this server's own origin, which `allowRequest` admits as
    // same-origin.
    ...createOxySocketCors({ appOrigins: appOriginsFor(process.env.WEB_URL) }),
    transports: ['websocket', 'polling'],
    // Engine.IO's own heartbeat, stated rather than defaulted because two idle timeouts sit in
    // front of this socket: the edge ALB's 60 s (`oxy-infra` alb-edge.tf) and Cloudflare's 100 s
    // for a proxied WebSocket. A ping every 25 s keeps the connection busy well inside both, and a
    // client that misses one for 20 s more is gone (`docs/realtime.mdx`).
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Upgrades to other paths belong to `lib/websocket-upgrades.ts`, which
    // refuses unknown ones itself. engine.io's default ends any upgrade it did
    // not serve after 1 s unless `socket.bytesWritten > 0`, which an upgraded
    // socket reports as 0 under Bun: it killed every voice and MCP socket.
    destroyUpgrade: false,
  });

  /**
   * Attach the Redis adapter, which is what makes a room work across tasks.
   *
   * ## The `.connect()` calls that used to be here never succeeded
   *
   * `ioredis` connects on construction unless `lazyConnect` is set, and
   * `lib/redis.ts` does not set it — so `getRedisClient()` hands back a client
   * that is ALREADY connecting, and calling `.connect()` on it rejects with
   * `Redis is already connecting/connected`. That rejection landed in the catch
   * below, which logged a warning and carried on with the in-memory adapter.
   *
   * Measured in production on 2026-08-24, on BOTH running tasks:
   *
   *     Error: Redis is already connecting/connected
   *         at initSocket (/app/packages/api/dist/index.js:13858)
   *     msg: "Socket.IO Redis adapter failed — using in-memory"
   *
   * So with `desiredCount: 2` every task ran its own in-memory adapter, and a
   * room only ever reached the clients that happened to land on the same task.
   * The failure mode is why it survived: a notification or an activity event
   * that reaches half its subscribers looks like a flaky client, never like a
   * broken fan-out. `GET /local-runtimes` is the
   * first read that fails LOUDLY on it, because `fetchSockets()` returns an
   * empty list rather than a late event.
   *
   * Nothing needs awaiting: `createAdapter` issues its subscribe through the
   * client, and ioredis queues commands until the connection is up
   * (`enableOfflineQueue` defaults to true). Attaching synchronously also
   * removes a window where a socket could connect before the adapter existed.
   */
  const pubClient = getRedisClient();
  const subClient = getRedisSubClient();
  if (pubClient && subClient) {
    io.adapter(createAdapter(pubClient, subClient));
    log.general.info('Socket.IO Redis adapter attached');
  } else {
    // One task, or no Redis configured. Correct in development; in production
    // it means rooms do not cross tasks, which is worth saying out loud.
    log.general.warn('Socket.IO has no Redis adapter — rooms are per-task');
  }
  // Authenticate every connection. `oxy.middleware.socket()` validates the handshake
  // bearer token, plants `socket.data.userId`, and rejects unauthenticated /
  // invalid / expired tokens before any `connection` handler runs.
  io.use(oxy.middleware.socket());

  bindRealtimeServer(io);

  io.on('connection', (socket) => {
    const userId = socketUserId(socket);
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    // The account's own room: every frame for this person (`lib/realtime/publish.ts`). Derived from
    // the authenticated user and never from anything the client sends, so a connection hears its
    // own account and nobody else's. Joined here, once, rather than on request: it is a property of
    // the connection, and a request a client could forget is a client that hears nothing.
    Promise.resolve(socket.join(accountRoom(userId))).catch((err) =>
      log.general.warn({ err }, 'socket.join account room failed'),
    );
    attachRealtimeHandlers(socket, userId, socketAccessToken(socket));

    /**
     * A device OFFERING its own inference runtime — a browser tab with Ollama on
     * the same machine, and later a local bridge or the native app.
     *
     * The catalogue of models travels with the offer and is kept on the socket
     * rather than in a table, because a runtime's lifetime IS its socket's
     * lifetime: anything persisted would keep advertising a model after the tab
     * that could serve it was closed. It is also what lets the person's OTHER
     * devices see the list — a phone cannot reach the laptop's `localhost`, so
     * without this announcement a local model would be unusable anywhere but
     * the machine running it. The other devices hear `runtimes` the moment one
     * joins or leaves, and read the list again.
     *
     * The endpoint URL is deliberately NOT part of the offer. It never leaves
     * the browser that talks to it.
     */
    socket.on('subscribe-user-runtime', (offer: unknown) => {
      const presence = runtimeOffer(offer);
      if (!presence) return;
      socket.data.localRuntime = presence;
      Promise.resolve(socket.join(userRuntimeRoom(userId)))
        .then(() => signalAccount(userId, 'runtimes', {}))
        .catch((err) => log.general.warn({ err }, 'socket.join user-runtime failed'));
    });

    /**
     * Withdraw the offer without dropping the connection — what the settings
     * toggle does. Leaving the room is not enough on its own: `socket.data`
     * still holds the catalogue, and a later re-join would re-advertise a stale
     * model list.
     */
    socket.on('unsubscribe-user-runtime', () => {
      const offered = socket.data.localRuntime !== undefined;
      delete socket.data.localRuntime;
      Promise.resolve(socket.leave(userRuntimeRoom(userId)))
        .then(() => {
          if (offered) signalAccount(userId, 'runtimes', {});
        })
        .catch((err) => log.general.warn({ err }, 'socket.leave user-runtime failed'));
    });

    // A tab that offered a runtime and closed takes its models with it.
    socket.on('disconnect', () => {
      if (socket.data.localRuntime !== undefined) signalAccount(userId, 'runtimes', {});
    });

    /**
     * Reply frames from a runtime, on their way back to whichever task is
     * serving the chat request that asked for them.
     *
     * The authenticated `userId` is passed through and re-checked against the
     * run's owner in the bridge. The run id alone is not an authorisation.
     */
    socket.on('user-runtime:head', (frame: { runId?: unknown; status?: unknown }) => {
      if (typeof frame?.runId !== 'string') return;
      const status = typeof frame.status === 'number' ? frame.status : 200;
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'head', status });
    });

    socket.on('user-runtime:chunk', (frame: { runId?: unknown; data?: unknown }) => {
      if (typeof frame?.runId !== 'string') return;
      const { data } = frame;
      const bytes =
        typeof data === 'string'
          ? data
          : data instanceof Uint8Array
            ? data
            : Buffer.isBuffer(data)
              ? new Uint8Array(data)
              : null;
      if (bytes === null) return;
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'chunk', data: bytes });
    });

    socket.on('user-runtime:end', (frame: { runId?: unknown }) => {
      if (typeof frame?.runId !== 'string') return;
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'end' });
    });

    socket.on('user-runtime:error', (frame: { runId?: unknown; message?: unknown }) => {
      if (typeof frame?.runId !== 'string') return;
      /**
       * The runtime's own failure text is the CALLER'S OWN environment talking
       * back, so it is capped rather than sanitised — but never trusted for
       * length, because a client controls it.
       */
      const message =
        typeof frame.message === 'string'
          ? frame.message.slice(0, 500)
          : 'The local runtime failed.';
      deliverUserRuntimeMessage(userId, { runId: frame.runId, kind: 'error', message });
    });
  });
  return io;
}

export function getIO(): Server | null {
  return io;
}

export interface AgentActivityEvent {
  type:
    | 'system'
    | 'thinking'
    | 'response'
    | 'tool_call'
    | 'tool_result'
    | 'error'
    | 'complete'
    | 'screenshot'
    | 'plan_progress'
    | 'file_change'
    | 'source_found'
    | 'threat';
  content: string;
  timestamp: number;
  sessionId: string;
  metadata?: {
    toolName?: string;
    args?: any;
    duration?: number;
    url?: string;
    title?: string;
    domain?: string;
    threatSeverity?: string;
    threatCategory?: string;
  };
  data?: {
    base64?: string;
    url?: string;
    plan?: {
      items: Array<{ id: number; text: string; status: string }>;
      completed: number;
      total: number;
    };
    files?: string[];
    currentStep?: number;
    maxSteps?: number;
    taskProgress?: {
      stepIndex: number;
      maxSteps: number;
      totalTokens: number;
      state: string;
      planCompleted: number;
      planTotal: number;
      elapsedMs: number;
      lastAction: string | null;
    };
  };
}

/** What Alia is doing for a person, coarsely: enough to animate her avatar, nothing of the work itself. */
export type AliaActivityState = 'idle' | 'thinking' | 'working' | 'writing';

export interface AliaActivityEvent {
  state: AliaActivityState;
  agentId: string;
  sessionId: string;
  timestamp: number;
}

/**
 * `alia:activity`, the frame `@gemies/sdk` before 6.0 (and `@alia.onl/sdk`) listens for to animate
 * the "Ask Alia" button that every Oxy app embeds. It is a contract between Oxy products, kept until
 * those apps are on `@gemies/sdk` 6, which reads the same state from `activity` on `rt`
 * (`docs/realtime.mdx`, "Compatibility"); nothing in this repository listens for it.
 */
export function emitLegacyAliaActivity(userId: string, data: AliaActivityEvent) {
  io?.to(accountRoom(userId)).emit('alia:activity', { eventVersion: 1, ...data });
}

/** An agent run's detailed activity, to whoever follows the agent or the session (`rt:subscribe`). */
export function emitAgentActivity(agentId: string, data: AgentActivityEvent) {
  const frame = { agentId, ...data };
  signalTopic(`agent:${agentId}`, 'agent.activity', frame);
  if (data.sessionId) signalTopic(`agent-session:${data.sessionId}`, 'agent.activity', frame);
}
