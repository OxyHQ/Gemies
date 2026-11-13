/**
 * What a client asks of the realtime socket (`docs/realtime.mdx`): catch up from its cursor, and
 * follow a topic beyond its own account's events.
 *
 * The account's own room (`user:<id>`) needs no asking: every authenticated connection joins it on
 * connect (`socket.ts`), because who may hear an account's events is exactly who authenticated as
 * it. A topic is someone else's stream — an agent's live work — and each one has its gate here.
 */

import type { Socket } from 'socket.io';
import { getDb } from '../../db/index.js';
import {
  accountHasSessionWithAgent,
  agentSessionIsOwnedBy,
} from '../../db/agents/agentSessionRepository.js';
import { accountEventHead, accountEventsSince } from '../../db/realtime/accountEventRepository.js';
import { ACCOUNT_EVENT_REPLAY_LIMIT } from '../../domain/account-events.js';
import { loadAgentForActor } from '../agent-account.js';
import { log } from '../logger.js';
import {
  REALTIME_SUBSCRIBE,
  REALTIME_SYNC,
  REALTIME_UNSUBSCRIBE,
  type RealtimeFrame,
  type RealtimeSyncReply,
} from './contract.js';

type Ack<T> = (reply: T) => void;

const ID_MAX = 256;

/** A topic a client may follow, parsed; `null` for anything else. */
export function parseTopic(
  value: unknown,
): { kind: 'agent' | 'agent-session'; id: string; room: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^(agent|agent-session):(.+)$/.exec(value);
  if (!match) return null;
  const [, kind, id] = match;
  if (!id || id.length > ID_MAX) return null;
  return { kind: kind as 'agent' | 'agent-session', id, room: value };
}

/**
 * Whether this person may follow an agent's live work: they may act as its account (the operator
 * ground, `account:act_as` at Oxy — the same question as who may edit it), or they have a session
 * with it. The verdict is cached: a reconnecting client re-subscribes to every topic it followed,
 * which is a burst of the same question.
 */
async function mayFollowAgent(userId: string, accessToken: string | null, agentId: string) {
  const operator =
    accessToken !== null &&
    (
      await loadAgentForActor(getDb(), {
        agentId,
        oxyUserId: userId,
        accessToken,
        cache: true,
      })
    ).ok;
  return operator || (await accountHasSessionWithAgent(getDb(), agentId, userId));
}

/** A session's room only for its owner. An EXISTS, never a fetched row: a gate is not a read. */
async function mayFollowSession(userId: string, sessionId: string) {
  return agentSessionIsOwnedBy(getDb(), sessionId, userId);
}

/** Wire `rt:sync`, `rt:subscribe` and `rt:unsubscribe` on one authenticated connection. */
export function attachRealtimeHandlers(
  socket: Socket,
  userId: string,
  accessToken: string | null,
): void {
  socket.on(REALTIME_SYNC, async (request: unknown, ack: unknown) => {
    if (typeof ack !== 'function') return;
    const reply = ack as Ack<RealtimeSyncReply>;
    const since =
      typeof request === 'object' && request !== null
        ? (request as { since?: unknown }).since
        : undefined;
    try {
      if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) {
        // A client with no cursor yet takes the head and reads its state over HTTP.
        reply({ head: await accountEventHead(getDb(), userId) });
        return;
      }
      const { head, events, gap } = await accountEventsSince(
        getDb(),
        userId,
        since,
        ACCOUNT_EVENT_REPLAY_LIMIT,
      );
      if (gap) {
        reply({ head, reset: true });
        return;
      }
      reply({
        head,
        events: events.map(
          (event): RealtimeFrame => ({ v: 1, type: event.type, data: event.data, seq: event.seq }),
        ),
      });
    } catch (err: unknown) {
      log.general.warn({ err }, 'Realtime catch-up failed');
      // The client keeps its cursor and asks again on its next connect.
      reply({ head: -1 });
    }
  });

  socket.on(REALTIME_SUBSCRIBE, async (request: unknown, ack: unknown) => {
    const reply = typeof ack === 'function' ? (ack as Ack<{ ok: boolean }>) : () => undefined;
    const topic = parseTopic(
      typeof request === 'object' && request !== null
        ? (request as { topic?: unknown }).topic
        : undefined,
    );
    if (!topic) {
      reply({ ok: false });
      return;
    }
    try {
      const allowed =
        topic.kind === 'agent'
          ? await mayFollowAgent(userId, accessToken, topic.id)
          : await mayFollowSession(userId, topic.id);
      if (!allowed) {
        reply({ ok: false });
        return;
      }
      await socket.join(topic.room);
      reply({ ok: true });
    } catch (err: unknown) {
      log.general.warn({ err, topic: topic.kind }, 'Realtime subscription failed');
      reply({ ok: false });
    }
  });

  socket.on(REALTIME_UNSUBSCRIBE, (request: unknown) => {
    const topic = parseTopic(
      typeof request === 'object' && request !== null
        ? (request as { topic?: unknown }).topic
        : undefined,
    );
    if (!topic) return;
    Promise.resolve(socket.leave(topic.room)).catch((err: unknown) =>
      log.general.warn({ err }, 'socket.leave topic failed'),
    );
  });
}
