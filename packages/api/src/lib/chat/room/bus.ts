/**
 * The room event bus: how what a member does in a room reaches whoever is watching it (ADR 0025).
 *
 * A room's worker publishes; anything that wants to see the room subscribes — the HTTP request that
 * started the chain (it forwards the events as the SSE frames it always sent) and, through
 * {@link publishRoomEvent}, the person's sockets. They may be on different instances than the
 * worker, so with Redis the bus is Redis pub/sub on the existing clients; without it, a process-local
 * emitter. Delivery is at-most-once and best effort: the stored message is the record, an event only
 * makes it live.
 */

import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import { log } from '../../logger.js';
import { getRedisClient, getRedisSubClient } from '../../redis.js';
import { signalAccount } from '../../realtime/publish.js';
import { startActorActivity, type ActorActivity } from '../../realtime/activity.js';

/** The event names a room publishes (`alia.agent_*` are the frames `docs/agent-embedding.md` §4 defines). */
type RoomEventName =
  | 'alia.agent_start'
  | 'alia.agent_delta'
  | 'alia.agent_tool'
  | 'alia.agent_end'
  /** A member's reply was stored: `{ message }`. */
  | 'group.message'
  /** The chain is over (or skipped): `{ reason }`. */
  | 'group.idle';

export interface RoomEvent {
  readonly userId: string;
  readonly conversationId: string;
  /** The person message the chain answers (its row id); lets a subscriber ignore other chains. */
  readonly chainId: string;
  readonly event: RoomEventName;
  /** The frame body, without `eventVersion`. */
  readonly data: Record<string, unknown>;
}

type RoomEventHandler = (event: RoomEvent) => void;

export interface RoomBus {
  publish(event: RoomEvent): Promise<void>;
  /** Calls `handler` for every event of one person's conversation until the returned function runs. */
  subscribe(userId: string, conversationId: string, handler: RoomEventHandler): () => void;
}

const channelOf = (userId: string, conversationId: string) =>
  `alia:group-room:${userId}:${conversationId}`;

function deliver(handlers: Iterable<RoomEventHandler>, event: RoomEvent): void {
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (err: unknown) {
      log.general.warn({ err, event: event.event }, 'A room event subscriber threw');
    }
  }
}

/** Process-local bus: the no-Redis fallback, and the bus tests run on. */
export function createInMemoryRoomBus(): RoomBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    async publish(event) {
      emitter.emit(channelOf(event.userId, event.conversationId), event);
    },
    subscribe(userId, conversationId, handler) {
      const channel = channelOf(userId, conversationId);
      const listener = (event: RoomEvent) => deliver([handler], event);
      emitter.on(channel, listener);
      return () => emitter.off(channel, listener);
    },
  };
}

/**
 * Redis pub/sub bus. One subscriber connection serves every channel of the process: a channel is
 * subscribed while it has a handler and released with the last one. A publish that fails is
 * delivered to this process's own subscribers instead, so a Redis blip degrades to "only the
 * instance that ran the worker sees it live" rather than to silence.
 */
export function createRedisRoomBus(publisher: Redis, subscriber: Redis): RoomBus {
  const handlers = new Map<string, Set<RoomEventHandler>>();
  subscriber.on('message', (channel: string, payload: string) => {
    const set = handlers.get(channel);
    if (!set) return;
    try {
      deliver(set, JSON.parse(payload) as RoomEvent);
    } catch (err: unknown) {
      log.general.warn({ err, channel }, 'Could not read a room event');
    }
  });
  return {
    async publish(event) {
      const channel = channelOf(event.userId, event.conversationId);
      try {
        await publisher.publish(channel, JSON.stringify(event));
      } catch (err: unknown) {
        log.general.warn({ err, channel }, 'Could not publish a room event; delivering locally');
        const set = handlers.get(channel);
        if (set) deliver(set, event);
      }
    },
    subscribe(userId, conversationId, handler) {
      const channel = channelOf(userId, conversationId);
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        subscriber.subscribe(channel).catch((err: unknown) => {
          log.general.warn({ err, channel }, 'Could not subscribe to a room channel');
        });
      }
      set.add(handler);
      return () => {
        const current = handlers.get(channel);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlers.delete(channel);
          subscriber.unsubscribe(channel).catch(() => undefined);
        }
      };
    },
  };
}

let shared: RoomBus | null = null;

/** The process's bus: Redis when `REDIS_URL` is set, else in-process. */
export function getRoomBus(): RoomBus {
  if (shared) return shared;
  const publisher = getRedisClient();
  const subscriber = getRedisSubClient();
  shared =
    publisher && subscriber ? createRedisRoomBus(publisher, subscriber) : createInMemoryRoomBus();
  return shared;
}

/**
 * Publish a room event to everyone watching: the bus (for the request that started the chain, on
 * any instance) and the person's sockets, scoped by `conversationId`. The socket room is reached
 * through the Socket.IO Redis adapter, so one emit serves every instance.
 *
 * On the socket it is the `room` signal (`docs/realtime.mdx`): `{ conversationId, chainId, event, data }`.
 */
export async function publishRoomEvent(event: RoomEvent): Promise<void> {
  await getRoomBus().publish(event);
  followRoomActivity(event);
  signalAccount(event.userId, 'room', {
    conversationId: event.conversationId,
    chainId: event.chainId,
    event: event.event,
    data: event.data,
  });
}

/**
 * Each member's turn as the person's surfaces show it ("Pepe is typing…", `activity`), derived from
 * the frames that turn already publishes, so a room has one source of what its members do. The
 * frames are published by the task running the chain, which is where the heartbeat must live.
 */
const memberActivities = new Map<string, ActorActivity>();

function followRoomActivity(event: RoomEvent): void {
  const room = `${event.userId}:${event.conversationId}:`;
  if (event.event === 'group.idle') {
    for (const [key, activity] of memberActivities) {
      if (!key.startsWith(room)) continue;
      activity.end();
      memberActivities.delete(key);
    }
    return;
  }
  const consultId = typeof event.data.consultId === 'string' ? event.data.consultId : null;
  if (consultId === null) return;
  const key = room + consultId;
  if (event.event === 'alia.agent_start') {
    const agent = event.data.agent as { id?: unknown; name?: unknown } | undefined;
    memberActivities.get(key)?.end();
    const activity = startActorActivity({
      oxyUserId: event.userId,
      conversationId: event.conversationId,
      agentId: typeof agent?.id === 'string' ? agent.id : null,
      name: typeof agent?.name === 'string' ? agent.name : null,
    });
    activity.set('thinking');
    memberActivities.set(key, activity);
    return;
  }
  const activity = memberActivities.get(key);
  if (!activity) return;
  if (event.event === 'alia.agent_delta') activity.set('writing');
  else if (event.event === 'alia.agent_tool') {
    if (event.data.phase === 'call')
      activity.set('tool', typeof event.data.name === 'string' ? event.data.name : undefined);
    else activity.set('thinking');
  } else if (event.event === 'alia.agent_end') {
    activity.end();
    memberActivities.delete(key);
  }
}
