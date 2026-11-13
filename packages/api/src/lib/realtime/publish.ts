/**
 * Publishing on the realtime socket (`docs/realtime.mdx`).
 *
 * Every frame for a person goes to the Socket.IO room `user:<oxyUserId>`, which every connection of
 * that account joins on connect; the Redis adapter (`socket.ts`) carries one emit to every API task.
 * Topic frames go to their topic's room.
 *
 * - {@link publishAccountEvent}: a DURABLE change, appended to the account's log first so a client
 *   that missed it gets it back from `rt:sync`. Called after the change itself committed.
 * - {@link signalAccount} / {@link signalTopic}: what is only true while it happens (typing,
 *   presence, progress). Never logged.
 *
 * Nothing here throws: a change that committed must not fail its request because a socket could not
 * be told. A frame that could not be logged is still pushed live; a client that misses that one
 * repairs it on its next reload, and the failure is logged.
 */

import type { Server } from 'socket.io';
import { appendAccountEvent } from '../../db/realtime/accountEventRepository.js';
import { getDb } from '../../db/index.js';
import type { AccountEventType } from '../../domain/account-events.js';
import { log } from '../logger.js';
import { REALTIME_EVENT, type RealtimeFrame, type RealtimeSignalType } from './contract.js';

let server: Server | null = null;

/** Called once by `initSocket`: the server every frame is emitted through. */
export function bindRealtimeServer(io: Server | null): void {
  server = io;
}

/** The room every connection of one account is in. */
export function accountRoom(oxyUserId: string): string {
  return `user:${oxyUserId}`;
}

function emit(room: string, frame: RealtimeFrame): void {
  server?.to(room).emit(REALTIME_EVENT, frame);
}

/** Log a durable change for the account and push it to the account's sockets with its number. */
export async function publishAccountEvent(
  oxyUserId: string,
  type: AccountEventType,
  data: unknown,
): Promise<void> {
  try {
    const event = await appendAccountEvent(getDb(), oxyUserId, type, data);
    emit(accountRoom(oxyUserId), { v: 1, type, data, seq: event.seq });
  } catch (err: unknown) {
    log.general.warn({ err, type }, 'Could not log a realtime event; pushing it live only');
    emit(accountRoom(oxyUserId), { v: 1, type, data });
  }
}

/** Push a signal to every connection of the account. */
export function signalAccount(oxyUserId: string, type: RealtimeSignalType, data: unknown): void {
  emit(accountRoom(oxyUserId), { v: 1, type, data });
}

/** Push a signal to whoever follows a topic (`rt:subscribe`, gated in `socket-handlers.ts`). */
export function signalTopic(topic: string, type: RealtimeSignalType, data: unknown): void {
  emit(topic, { v: 1, type, data, topic });
}
