import type { MetricDefinition, MetricLabels } from '@oxy.so/telemetry/metrics';
import { describe, expect, it } from 'vitest';
import {
  AGENT_INBOX_PENDING,
  publishOperationalGauges,
  QUEUE_JOBS,
  queueGauges,
} from '../operational-metrics.js';

describe('queueGauges', () => {
  it('has one gauge per queue and state, and nothing for a queue that has no Redis', () => {
    const gauges = queueGauges([
      { queue: 'agent-sessions', counts: { waiting: 2, active: 1 } },
      { queue: 'alia-tasks', counts: null },
    ]);
    expect(gauges.map((g) => [g.labels?.Queue, g.labels?.State, g.value])).toEqual([
      ['agent-sessions', 'waiting', 2],
      ['agent-sessions', 'active', 1],
    ]);
    expect(gauges.every((g) => g.metric === QUEUE_JOBS)).toBe(true);
  });

  it('promotes only the closed Queue and State pair to a dimension', () => {
    expect(QUEUE_JOBS.dimensionSets).toEqual([['Queue', 'State']]);
  });
});

describe('publishOperationalGauges', () => {
  /** A database that answers every count with 4. */
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ n: 4 }] }) }),
  } as unknown as Parameters<typeof publishOperationalGauges>[1]['db'];

  function recorder() {
    const seen: Array<{ metric: MetricDefinition; value: number; labels?: MetricLabels }> = [];
    return {
      seen,
      publisher: {
        record: (metric: MetricDefinition, value: number, labels?: MetricLabels) => {
          seen.push({ metric, value, labels });
        },
        flush: () => {},
        stop: () => {},
      },
    };
  }

  it('records the database gauges and the queue depths', async () => {
    const { seen, publisher } = recorder();
    await publishOperationalGauges(publisher, {
      db,
      queues: [{ queue: 'alia-tasks', counts: async () => ({ waiting: 5 }) }],
    });
    expect(seen).toContainEqual({
      metric: QUEUE_JOBS,
      value: 5,
      labels: { Queue: 'alia-tasks', State: 'waiting' },
    });
    expect(seen).toContainEqual({ metric: AGENT_INBOX_PENDING, value: 4, labels: undefined });
  });

  it('still publishes when a queue cannot be counted', async () => {
    const { seen, publisher } = recorder();
    await publishOperationalGauges(publisher, {
      db,
      queues: [
        {
          queue: 'agent-sessions',
          counts: async () => {
            throw new Error('redis down');
          },
        },
        { queue: 'alia-tasks', counts: async () => ({ active: 1 }) },
      ],
    });
    const queues = seen.filter((r) => r.metric === QUEUE_JOBS).map((r) => r.labels?.Queue);
    expect(queues).toEqual(['alia-tasks']);
  });
});
