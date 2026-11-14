/**
 * The queue of conversations between gemies (ADR 0041): one job per step of a chain, on the shared
 * conversation step queue the group rooms use (`../room/step-queue.ts`), under its own name.
 */

import { createStepQueue } from '../room/step-queue.js';
import type { GemieStepData } from './engine.js';

/** One job per (chain, step): a step is queued once however often it is asked. */
export const gemieJobIdOf = (data: Pick<GemieStepData, 'chainId' | 'turn' | 'phase'>) =>
  `gemies-${data.chainId}-${data.turn}-${data.phase}`;

const queue = createStepQueue<GemieStepData>({
  name: 'gemie-conversations',
  label: 'gemie conversation',
  jobIdOf: gemieJobIdOf,
  conversationIdOf: (data) => data.conversationId,
  process: async (data) => {
    const { gemieRuntime } = await import('./runtime.js');
    await gemieRuntime().processStep(data);
  },
  abandon: async (data) => {
    const { gemieRuntime } = await import('./runtime.js');
    await gemieRuntime().abandon(data);
  },
  // A lost acknowledgement may have queued the step already: a turn is retried, never run twice.
  directOnEnqueueFailure: () => false,
});

export const initGemieQueue = () => queue.init();
export const startGemieWorker = () => queue.startWorker();
export const enqueueGemieStep = (data: GemieStepData) => queue.enqueue(data);
export const shutdownGemieQueue = () => queue.shutdown();
