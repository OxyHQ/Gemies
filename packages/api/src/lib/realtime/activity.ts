/**
 * "Pepe is typing…": what an actor is doing, told to the person's surfaces (`docs/realtime.mdx`).
 *
 * One {@link ActorActivity} per actor per piece of work (a turn, a room member's reply, an agent
 * run). It sends a state when it CHANGES — a tool-heavy turn is not a flood — and repeats the
 * current one every {@link ACTIVITY_HEARTBEAT_MS} while it lasts, the way WhatsApp repeats
 * "composing": a client forgets a state it has not heard for {@link ACTIVITY_TTL_MS}, so a run that
 * crashed without saying `idle` stops showing, and a client that reconnects mid-turn hears it again.
 */

import { publicAgentId } from '../../domain/alia-gemie.js';
import {
  ACTIVITY_HEARTBEAT_MS,
  ACTIVITY_TTL_MS,
  type ActivitySignal,
  type ActivityState,
} from './contract.js';
import { signalAccount } from './publish.js';

export interface ActorActivity {
  /** What the actor is doing now; a repeat of the current state sends nothing. */
  set(state: Exclude<ActivityState, 'idle'>, tool?: string): void;
  /** The work is over: `idle` is sent once and the heartbeat stops. Idempotent. */
  end(): void;
}

export interface ActorActivityInput {
  readonly oxyUserId: string;
  readonly conversationId: string | null;
  readonly sessionId?: string;
  /** The gemie's stored id (`agents.id`); published as its public id. `null`: no gemie. */
  readonly agentId: string | null;
  readonly name?: string | null;
}

/** Start telling the person what one actor is doing. Nothing is sent until the first `set`. */
export function startActorActivity(input: ActorActivityInput): ActorActivity {
  let current: { state: ActivityState; tool?: string } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ended = false;
  const actor = {
    agentId: input.agentId === null ? null : publicAgentId(input.agentId),
    ...(input.name === undefined ? {} : { name: input.name }),
  };

  const send = (): void => {
    if (!current) return;
    const signal: ActivitySignal = {
      conversationId: input.conversationId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      actor,
      state: current.state,
      ...(current.tool === undefined ? {} : { tool: current.tool }),
      ttlMs: ACTIVITY_TTL_MS,
    };
    signalAccount(input.oxyUserId, 'activity', signal);
  };

  return {
    set(state, tool) {
      if (ended) return;
      if (current?.state === state && current.tool === tool) return;
      current = { state, ...(tool === undefined ? {} : { tool }) };
      send();
      if (timer === null) {
        timer = setInterval(send, ACTIVITY_HEARTBEAT_MS);
        timer.unref?.();
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      // Nothing was ever shown: nothing to take back.
      if (current === null) return;
      current = { state: 'idle' };
      send();
    },
  };
}
