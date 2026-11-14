/**
 * The engine of conversations between gemies wired to the real world. Everything a room needs —
 * Postgres, the agent turn, the bus, the lock, Oxy tasks — is the room runtime's own
 * (`../room/runtime.ts`); this only adds the gemie queue and the chain bounds in force.
 */

import { conversationIsActive, holdConversationActivity } from '../activity.js';
import { roomRuntime } from '../room/runtime.js';
import {
  type GemieEngineDeps,
  type GemieStepData,
  abandonGemieChain,
  processGemieStep,
} from './engine.js';
import { gemieChainBounds } from './policy.js';
import { enqueueGemieStep } from './queue.js';
import { outreachMessageIdOf } from '../../agent/agent-outreach.js';

export interface GemieRuntime {
  readonly deps: GemieEngineDeps;
  processStep(data: GemieStepData): Promise<void>;
  abandon(data: GemieStepData): Promise<void>;
}

let runtime: GemieRuntime | null = null;

/**
 * How long a continuation waits for the person's chat to be quiet. A live turn there is bounded at
 * 80 seconds (`routes/v1/chat-completions.ts`) and stores its reply as it ends; the answer of the
 * gemie it wrote to can arrive before that, and what the writer then says belongs AFTER its own
 * reply, in a conversation the live turn has finished storing.
 */
const QUIET_WAIT_MS = 90_000;
const QUIET_POLL_MS = 1_000;

async function untilQuiet(userId: string, conversationId: string): Promise<void> {
  const deadline = Date.now() + QUIET_WAIT_MS;
  while (Date.now() < deadline && (await conversationIsActive(userId, conversationId))) {
    await new Promise((resolve) => setTimeout(resolve, QUIET_POLL_MS));
  }
}

export function gemieRuntime(): GemieRuntime {
  if (runtime) return runtime;
  const deps: GemieEngineDeps = {
    get room() {
      return roomRuntime().deps;
    },
    enqueue: enqueueGemieStep,
    tellPerson: async (input) => {
      const { postAgentMessage } = await import('../../agent/agent-outreach.js');
      const post = (conversationId?: string) =>
        postAgentMessage({
          oxyUserId: input.userId,
          agentId: input.agentId,
          kind: 'result',
          idempotencyKey: input.key,
          content: input.content,
          ...(conversationId ? { conversationId } : {}),
        });
      // The chat it wrote from; its thread with the person when that chat is gone.
      let outcome = await post(input.conversationId);
      if (!outcome.posted && outcome.reason === 'conversation_not_found') outcome = await post();
      return outcome.posted ? { messageId: outcome.messageId } : null;
    },
    toldIdOf: (key) => outreachMessageIdOf('result', key),
    bounds: gemieChainBounds(),
  };
  runtime = {
    deps,
    processStep: async (data) => {
      // The conversation this step writes in is busy while it runs, as a room's is: a reaction there
      // waits for it (ADR 0025).
      const writesIn = data.phase === 'reply' ? data.conversationId : data.originConversationId;
      if (data.phase === 'continue') await untilQuiet(data.userId, writesIn);
      const controller = new AbortController();
      const stop = await holdConversationActivity(
        data.userId,
        writesIn,
        `gemies:${data.chainId}:${data.turn}`,
        () => controller.abort(),
      );
      try {
        const room = deps.room;
        await processGemieStep(data, {
          ...deps,
          room: {
            ...room,
            runTurn: (input) => room.runTurn({ ...input, signal: controller.signal }),
          },
        });
      } finally {
        await stop();
      }
    },
    abandon: (data) => abandonGemieChain(data, deps),
  };
  return runtime;
}
