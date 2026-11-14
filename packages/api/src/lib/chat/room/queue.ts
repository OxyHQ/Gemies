/**
 * Group room queue — one job per step of a room's chain (ADR 0025), on the shared conversation step
 * queue (`step-queue.ts`). The v3 consumer is installed before producer activation; v2 and v1 retain workers to drain admitted jobs
 * with their original policy.
 */

import type { RoomJobData } from './engine.js';
import { createStepQueue } from './step-queue.js';

/** The id of a step's job: one per (chain, turn), so a step is queued once however often it is asked. */
export const jobIdOf = (
  data: Pick<RoomJobData, 'conversationId' | 'triggerId' | 'turns' | 'version' | 'phase'>,
) =>
  // BullMQ refuses ':' in a custom id.
  `room-${data.conversationId}-${data.triggerId}-${data.turns}${data.version !== undefined ? `-${data.phase}` : ''}`.replace(
    /:/g,
    '_',
  );

async function processStep(data: RoomJobData): Promise<void> {
  const { roomRuntime } = await import('./runtime.js');
  await roomRuntime().processStep(data);
}

async function abandon(data: RoomJobData): Promise<void> {
  const { roomRuntime } = await import('./runtime.js');
  await roomRuntime().abandon(data);
}

const queueOf = (name: string) =>
  createStepQueue<RoomJobData>({
    name,
    label: 'group room',
    jobIdOf,
    conversationIdOf: (data) => data.conversationId,
    process: processStep,
    abandon,
    // A lost Redis acknowledgement may have queued the selected turn already. Running it locally
    // would create a second execution with a possibly different selection: retry the durable job.
    directOnEnqueueFailure: (data) => data.version === undefined,
  });

const current = queueOf('group-rooms-v3');
const previous = queueOf('group-rooms-v2');
const legacy = queueOf('group-rooms');

/** Initialize the queues. Without Redis they stay off and {@link enqueueRoomJob} runs steps directly. */
export async function initRoomQueue(): Promise<void> {
  await Promise.all([current.init(), previous.init(), legacy.init()]);
}

/** Start v3 workers and the v2/v1 drains. Call once at startup, after {@link initRoomQueue}. */
export async function startRoomWorker(): Promise<void> {
  await current.startWorker();
  await previous.startWorker();
  await legacy.startWorker();
}

/** Queue one step. Deduplicated by chain and turn. */
export async function enqueueRoomJob(data: RoomJobData): Promise<void> {
  await (data.version === 3 ? current : data.version === 2 ? previous : legacy).enqueue(data);
}

/** Graceful shutdown. Call before process exit. */
export async function shutdownRoomQueue(): Promise<void> {
  await Promise.all([current.shutdown(), previous.shutdown(), legacy.shutdown()]);
}
