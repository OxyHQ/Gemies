/**
 * The canvas draws decks and dashboards only in the shape a surface can open,
 * and leaves every other type as it was.
 */
import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';

import { canvasTool } from '../canvas.js';

async function run(input: { type: string; title: string; data: unknown }) {
  return (await (
    canvasTool as unknown as {
      execute: (args: typeof input, options: unknown) => Promise<Record<string, unknown>>;
    }
  ).execute(input, { toolCallId: 't', messages: [] })) as Record<string, unknown>;
}

async function validate(input: unknown) {
  const schema = asSchema(canvasTool.inputSchema);
  return (await schema.validate?.(input)) ?? { success: true as const, value: input };
}

describe('canvas', () => {
  it('accepts deck and dashboard as types', async () => {
    expect((await validate({ type: 'deck', title: 'Pitch', data: {} })).success).toBe(true);
    expect((await validate({ type: 'dashboard', title: 'Sales', data: {} })).success).toBe(true);
    expect((await validate({ type: 'poster', title: 'X', data: {} })).success).toBe(false);
  });

  it('draws a deck in the shape the tool describes', async () => {
    const out = await run({
      type: 'deck',
      title: 'Pitch',
      data: {
        slides: [
          { title: 'Astro', subtitle: 'A browser' },
          { title: 'Why', bullets: ['Fast'], notes: 'Say it slowly' },
        ],
      },
    });
    expect(out.error).toBeUndefined();
    expect(out.type).toBe('deck');
    expect((out.data as { slides: unknown[] }).slides).toHaveLength(2);
  });

  it('draws a dashboard of stats, charts, tables and text', async () => {
    const out = await run({
      type: 'dashboard',
      title: 'Sales',
      data: {
        widgets: [
          { kind: 'stat', label: 'Revenue', value: '10M', delta: '+12%' },
          {
            kind: 'chart',
            title: 'Monthly',
            chartType: 'bar',
            labels: ['Jan'],
            datasets: [{ label: 'R', values: [1] }],
          },
          { kind: 'table', headers: ['Region'], rows: [['EU']] },
          { kind: 'text', content: 'Steady.' },
        ],
      },
    });
    expect(out.error).toBeUndefined();
    expect((out.data as { widgets: unknown[] }).widgets).toHaveLength(4);
  });

  it('tells the model what is wrong with a malformed deck or dashboard', async () => {
    const deck = await run({ type: 'deck', title: 'Pitch', data: { slides: [] } });
    expect(deck.error).toMatch(/^The deck was not drawn: slides: /);
    expect(deck.id).toBeUndefined();
    const dashboard = await run({
      type: 'dashboard',
      title: 'S',
      data: { widgets: [{ kind: 'gauge' }] },
    });
    expect(dashboard.error).toMatch(/^The dashboard was not drawn: widgets\.0\.kind/);
  });

  it('refuses a chart whose series has fewer values than labels, naming the series', async () => {
    const data = {
      chartType: 'bar',
      labels: ['Jan', 'Feb', 'Mar'],
      datasets: [
        { label: 'A', values: [1, 2, 3] },
        { label: 'B', values: [1] },
      ],
    };
    const chart = await run({ type: 'chart', title: 'Q1', data });
    expect(chart.error).toBe(
      'The chart was not drawn: datasets.1.values: needs 3 values, one per label; it has 1. Send it again in the shape the tool describes.',
    );
    expect(chart.id).toBeUndefined();
    const dashboard = await run({
      type: 'dashboard',
      title: 'Q1',
      data: { widgets: [{ kind: 'chart', ...data }] },
    });
    expect(dashboard.error).toMatch(
      /^The dashboard was not drawn: widgets\.0\.datasets\.1\.values: needs 3 values/,
    );
  });

  it('draws a chart whose every series has a value per label', async () => {
    const out = await run({
      type: 'chart',
      title: 'Q1',
      data: {
        chartType: 'line',
        labels: ['Jan', 'Feb'],
        datasets: [{ label: 'A', values: [1, 2] }],
      },
    });
    expect(out.error).toBeUndefined();
    expect(out.type).toBe('chart');
  });

  it('refuses a table row that does not have a cell per header, and a table without headers', async () => {
    const short = { headers: ['Region', 'Sales'], rows: [['EU', '10'], ['US']] };
    const table = await run({ type: 'table', title: 'Sales', data: short });
    expect(table.error).toBe(
      'The table was not drawn: rows.1: needs 2 cells, one per header; it has 1. Send it again in the shape the tool describes.',
    );
    const dashboard = await run({
      type: 'dashboard',
      title: 'Sales',
      data: { widgets: [{ kind: 'table', ...short }] },
    });
    expect(dashboard.error).toMatch(
      /^The dashboard was not drawn: widgets\.0\.rows\.1: needs 2 cells, one per header/,
    );
    const headless = await run({
      type: 'dashboard',
      title: 'Sales',
      data: { widgets: [{ kind: 'table', headers: [], rows: [] }] },
    });
    expect(headless.error).toMatch(/^The dashboard was not drawn: widgets\.0\.headers: /);
  });

  it('leaves the other types untouched', async () => {
    const out = await run({ type: 'markdown', title: 'Report', data: { content: '# Q3' } });
    expect(out).toMatchObject({ type: 'markdown', title: 'Report', data: { content: '# Q3' } });
  });
});
