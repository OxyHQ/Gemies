/**
 * A queue of conversation steps — BullMQ jobs, one per step of a chain — shared by group rooms
 * (ADR 0025) and conversations between gemies (ADR 0041).
 *
 * Pattern of `lib/alia-task-queue.ts`, including the direct-execution fallback without Redis. The
 * queue only carries steps; the order inside a conversation is the room lock's job (`lock.ts`), so
 * any number of workers on any number of instances may take jobs and one conversation still has one
 * speaker at a time. Each kind of step has its own queue NAME, so a worker never receives a payload
 * of a kind it does not know (an older image during a rolling deploy included).
 */

import { type Job, Queue, Worker } from 'bullmq';
import { log } from '../../logger.js';
import { getRedisConnection } from '../../redis.js';

/** A step that threw (database, lock) is retried once; a step's ids make the retry idempotent. */
export const STEP_ATTEMPTS = 2;

export interface StepQueueOptions<T> {
  readonly name: string;
  /** What logs call it. */
  readonly label: string;
  /** One id per step, so a step is queued once however often it is asked. BullMQ refuses ':'. */
  readonly jobIdOf: (data: T) => string;
  readonly conversationIdOf: (data: T) => string;
  readonly process: (data: T) => Promise<void>;
  /** A step whose retries are spent: end its chain for the watchers and give its authority back. */
  readonly abandon: (data: T) => Promise<void>;
  /**
   * Whether a step may run in this process when Redis refused it. A step whose decision is already
   * made may have been queued despite the error (a lost acknowledgement), and running it here too
   * would run it twice: such a step is retried by throwing instead.
   */
  readonly directOnEnqueueFailure: (data: T) => boolean;
}

export interface StepQueue<T> {
  init(): Promise<void>;
  startWorker(): Promise<void>;
  enqueue(data: T): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * BullMQ is given steps as plain objects: a step crosses Redis as JSON, so what a worker reads back is
 * the payload this queue put there, typed by {@link StepQueueOptions} at both ends.
 */
type Payload = object;

export function createStepQueue<T extends Payload>(options: StepQueueOptions<T>): StepQueue<T> {
  let queue: Queue<Payload, unknown, string> | null = null;
  let worker: Worker<Payload, unknown, string> | null = null;

  const runDirectly = (data: T) => {
    setImmediate(() => {
      options.process(data).catch((err: unknown) => {
        log.agents.error(
          { err, conversationId: options.conversationIdOf(data) },
          `Direct ${options.label} step failed`,
        );
        options.abandon(data).catch(() => undefined);
      });
    });
  };

  return {
    async init() {
      const connection = getRedisConnection();
      if (!connection) {
        log.general.info(
          `REDIS_URL not set — ${options.label} queue disabled, using direct execution`,
        );
        return;
      }
      try {
        const created = new Queue<Payload, unknown, string>(options.name, {
          connection,
          defaultJobOptions: {
            attempts: STEP_ATTEMPTS,
            backoff: { type: 'exponential', delay: 2_000 },
            removeOnComplete: { age: 24 * 3600, count: 1000 },
            removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
          },
        });
        await created.waitUntilReady();
        queue = created;
        log.general.info(`${options.label} queue initialized (BullMQ + Redis)`);
      } catch (err) {
        log.general.warn({ err }, `Failed to connect to Redis — ${options.label} queue disabled`);
        queue = null;
      }
    },

    async startWorker() {
      const connection = getRedisConnection();
      if (!connection || !queue) return;
      worker = new Worker<Payload, unknown, string>(
        options.name,
        async (job: Job<Payload, unknown, string>) => {
          log.agents.info(
            { conversationId: options.conversationIdOf(job.data as T), jobId: job.id },
            `Worker processing a ${options.label} step`,
          );
          await options.process(job.data as T);
        },
        // Steps of different conversations run in parallel; steps of one queue on its lock, so a
        // high concurrency would only park workers on a busy one.
        { connection, concurrency: 8 },
      );
      worker.on('failed', (job, err) => {
        log.agents.error({ jobId: job?.id, err }, `${options.label} step failed`);
        if (job && job.attemptsMade >= (job.opts.attempts ?? STEP_ATTEMPTS)) {
          options
            .abandon(job.data as T)
            .catch((abandonErr: unknown) =>
              log.agents.error(
                { err: abandonErr, jobId: job.id },
                `Could not abandon a ${options.label} chain`,
              ),
            );
        }
      });
      worker.on('error', (err) => {
        log.agents.error({ err }, `${options.label} worker error`);
      });
    },

    async enqueue(data) {
      if (queue) {
        try {
          await queue.add(`${options.label}:${options.conversationIdOf(data)}`, data, {
            jobId: options.jobIdOf(data).replace(/:/g, '_'),
            attempts: STEP_ATTEMPTS,
          });
          return;
        } catch (err) {
          if (!options.directOnEnqueueFailure(data)) throw err;
          log.agents.warn(
            { err, conversationId: options.conversationIdOf(data) },
            `Failed to enqueue a ${options.label} step — running it directly`,
          );
        }
      }
      // Without Redis the step runs off the caller's stack: the chain still outlives the request.
      runDirectly(data);
    },

    async shutdown() {
      if (worker) {
        await worker.close();
        worker = null;
      }
      if (queue) {
        await queue.close();
        queue = null;
      }
    },
  };
}
