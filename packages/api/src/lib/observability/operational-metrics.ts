/**
 * The operational gauges: what an operator needs to see that background work is flowing, read from
 * the stores that hold it and published to CloudWatch as EMF (`metrics.ts`).
 *
 * The counters in `metrics.ts` count what THIS process did and are summed across tasks; these are
 * facts about the system (a backlog, a stuck event, a queue's depth) and are true whichever instance
 * reads them, so only the trigger-engine leader publishes them (one series, not one per task). Each
 * is one cheap, indexed count.
 */

import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { agentInboxItems } from '../../db/schema/agent-runtime.js';
import { automationEvents } from '../../db/schema/agency.js';
import { channelInbound } from '../../db/schema/bots.js';
import type { EmfPublisher, MetricDefinition } from '@oxy.so/telemetry/metrics';
import type { ApiDatabase } from '../../db/index.js';
import { log } from '../logger.js';

const gauge = (name: string, dimensionSets?: readonly (readonly string[])[]): MetricDefinition => ({
  name,
  unit: 'Count',
  kind: 'gauge',
  ...(dimensionSets ? { dimensionSets } : {}),
});

/** Oxy events accepted but not dispatched for over two minutes (a sweep should take them). */
export const AUTOMATION_EVENTS_STALLED = gauge('AutomationEventsStalled');
/** Messaging-platform messages stored but not answered for over two minutes. */
export const CHANNEL_INBOUND_STALLED = gauge('ChannelInboundStalled');
/** Messaging-platform messages that could not be answered (kept for an hour). */
export const CHANNEL_INBOUND_FAILED = gauge('ChannelInboundFailed');
/** Items waiting in agents' inboxes for a heartbeat to deliver them. */
export const AGENT_INBOX_PENDING = gauge('AgentInboxPending');
/** BullMQ jobs by queue and state: two queues and BullMQ's fixed states, a closed set. */
export const QUEUE_JOBS = gauge('QueueJobs', [['Queue', 'State']]);

export interface OperationalGauge {
  metric: MetricDefinition;
  value: number;
  labels?: Record<string, string>;
}

/** Past these a row is not "in flight": the matching sweep should have taken it. */
const STALLED_EVENT_AFTER_MS = 2 * 60_000;
const STALLED_INBOUND_AFTER_MS = 2 * 60_000;

const count = async (query: PromiseLike<Array<{ n: number }>>): Promise<number> =>
  (await query)[0]?.n ?? 0;

/** Every gauge, from the database. A failed read is left out rather than reported as zero. */
export async function databaseGauges(
  db: Pick<ApiDatabase, 'select'>,
  now: Date = new Date(),
): Promise<OperationalGauge[]> {
  const eventCutoff = new Date(now.getTime() - STALLED_EVENT_AFTER_MS);
  const inboundCutoff = new Date(now.getTime() - STALLED_INBOUND_AFTER_MS);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const reads: Array<[MetricDefinition, Promise<number>]> = [
    [
      AUTOMATION_EVENTS_STALLED,
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(automationEvents)
          .where(
            and(
              inArray(automationEvents.status, ['received', 'matched']),
              lt(automationEvents.updatedAt, eventCutoff),
              gt(automationEvents.receivedAt, dayAgo),
            ),
          ),
      ),
    ],
    [
      CHANNEL_INBOUND_STALLED,
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(channelInbound)
          .where(
            and(
              inArray(channelInbound.status, ['received', 'processing']),
              lt(channelInbound.updatedAt, inboundCutoff),
            ),
          ),
      ),
    ],
    [
      CHANNEL_INBOUND_FAILED,
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(channelInbound)
          .where(eq(channelInbound.status, 'failed')),
      ),
    ],
    [
      AGENT_INBOX_PENDING,
      count(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(agentInboxItems)
          .where(eq(agentInboxItems.status, 'pending')),
      ),
    ],
  ];
  const settled = await Promise.allSettled(reads.map(([, value]) => value));
  return reads.flatMap(([metric], index) => {
    const result = settled[index];
    return result?.status === 'fulfilled' ? [{ metric, value: result.value }] : [];
  });
}

/** BullMQ job counts as gauges, one per (queue, state). Nothing without Redis. */
export function queueGauges(
  queues: ReadonlyArray<{ queue: string; counts: Record<string, number> | null }>,
): OperationalGauge[] {
  return queues.flatMap(({ queue, counts }) =>
    Object.entries(counts ?? {}).map(([state, value]) => ({
      metric: QUEUE_JOBS,
      value,
      labels: { Queue: queue, State: state },
    })),
  );
}

export interface MetricsSources {
  readonly db: Pick<ApiDatabase, 'select'>;
  readonly queues: ReadonlyArray<{
    queue: string;
    counts: () => Promise<Record<string, number> | null>;
  }>;
  readonly now?: Date;
}

/**
 * Read every gauge and record it. A queue that cannot be counted (Redis down) is left out; the rest
 * still publishes, because a monitor that dies when Redis does cannot say that Redis died.
 */
export async function publishOperationalGauges(
  publisher: EmfPublisher,
  sources: MetricsSources,
): Promise<void> {
  const [database, counted] = await Promise.all([
    databaseGauges(sources.db, sources.now),
    Promise.all(
      sources.queues.map(async ({ queue, counts }) => ({
        queue,
        counts: await counts().catch(() => null),
      })),
    ),
  ]);
  for (const { metric, value, labels } of [...database, ...queueGauges(counted)]) {
    publisher.record(metric, value, labels);
  }
}

/** How often the gauges are read: CloudWatch's standard resolution. */
const GAUGE_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Publish the gauges every minute while `isLeader()` says this task is the trigger-engine leader
 * (the predicate is consulted per tick, so leadership moving moves the publishing with it). A
 * failed read is logged, never thrown.
 */
export function startOperationalGauges(
  publisher: EmfPublisher | null,
  sources: MetricsSources,
  isLeader: () => boolean,
): void {
  if (!publisher || timer) return;
  timer = setInterval(() => {
    if (!isLeader()) return;
    publishOperationalGauges(publisher, sources).catch((error: unknown) => {
      log.general.error({ err: error }, 'Could not publish the operational gauges');
    });
  }, GAUGE_INTERVAL_MS);
  timer.unref();
}

export function stopOperationalGauges(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
