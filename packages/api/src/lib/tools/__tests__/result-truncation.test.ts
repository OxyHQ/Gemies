import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import {
  boundToolResult,
  clientToolResult,
  compactToolResult,
  wrapToolsWithTruncation,
} from '../result-truncation.js';

/**
 * What survives the truncation wrapper, and what does not.
 *
 * Every tool's result passes through this on its way to the model AND on its
 * way into `tool_invocations`, so whatever it rewrites is what a reader sees in
 * a reopened thread. A card whose numbers came back with
 * `[truncated — N chars omitted]` glued into them would render as garbage, and
 * nothing upstream would report a failure.
 *
 * A top-level `card` is never touched: everything else is compacted, then bounded, and this file
 * is the thing that keeps the card's property from being changed by accident.
 */

const LIMIT = 40;

const toolReturning = (value: unknown) =>
  wrapToolsWithTruncation(
    { probe: tool({ description: 'p', inputSchema: z.object({}), execute: async () => value }) },
    LIMIT,
  );

const run = async (value: unknown) => {
  const wrapped = toolReturning(value);
  return (wrapped.probe.execute as (i: unknown, o: unknown) => Promise<any>)({}, {});
};

const long = 'x'.repeat(500);

describe('wrapToolsWithTruncation', () => {
  it('truncates a top-level content field, which is what it is for', async () => {
    const out = await run({ content: long });
    expect(out.content).not.toBe(long);
    expect(out.content).toContain('truncated');
  });

  it('leaves a card payload intact, numbers and all', async () => {
    const card = {
      type: 'weather',
      version: 1,
      data: {
        place: 'Barcelona',
        hourly: Array.from({ length: 168 }, (_, i) => ({
          time: `h${i}`,
          temperature: 20 + (i % 10),
        })),
      },
    };
    const out = await run({ card, summary: 'Barcelona: 28°C.' });

    expect(out.card).toEqual(card);
    expect(out.card.data.hourly).toHaveLength(168);
    expect(JSON.stringify(out.card)).not.toContain('truncated');
  });

  it('does not reach a content field nested inside a card', async () => {
    const out = await run({ card: { type: 'news', version: 1, data: { content: long } } });
    expect(out.card.data.content).toBe(long);
  });

  it('still truncates a bare string result', async () => {
    const out = await run(long);
    expect(out).toContain('truncated');
  });
});

describe('a result too large for the model, whatever its shape', () => {
  const body = 'x'.repeat(5000);

  it('bounds a nested app result, which used to pass through whole', async () => {
    const wrapped = wrapToolsWithTruncation(
      {
        probe: tool({
          description: 'p',
          inputSchema: z.object({}),
          execute: async () => ({ data: { subject: 'Hi', body } }),
        }),
      },
      2000,
    );
    const out = (await (wrapped.probe.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      {},
      {},
    )) as Record<string, unknown>;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2200);
    expect((out.data as Record<string, unknown>).subject).toBe('Hi');
  });

  it('bounds a list of results and says how many it dropped', async () => {
    const emails = Array.from({ length: 80 }, (_, index) => ({
      id: `e${index}`,
      snippet: 'y'.repeat(300),
    }));
    const wrapped = wrapToolsWithTruncation(
      {
        probe: tool({
          description: 'p',
          inputSchema: z.object({}),
          execute: async () => ({ data: emails }),
        }),
      },
      4000,
    );
    const out = await (wrapped.probe.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      {},
      {},
    );
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4300);
  });

  it('still never touches a card, however large the rest is', async () => {
    const card = {
      type: 'weather',
      data: { hourly: Array.from({ length: 168 }, (_, h) => ({ h, t: 20 })) },
    };
    const wrapped = wrapToolsWithTruncation(
      {
        probe: tool({
          description: 'p',
          inputSchema: z.object({}),
          execute: async () => ({ card, data: { body } }),
        }),
      },
      2000,
    );
    const out = (await (wrapped.probe.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      {},
      {},
    )) as Record<string, unknown>;
    expect(out.card).toEqual(card);
  });
});

/**
 * Twenty unread emails as Inbox returns them (production 2026-11-14): a follow-up run that read
 * them as `{ truncated, preview }`, one escaped string of ids, could not summarise anything and
 * listed them again until its token budget ran out.
 */
describe('a list of app records too large for the budget', () => {
  const email = (index: number) => ({
    _id: `e${index}`,
    id: `e${index}`,
    from: { name: `Sender ${index}`, address: `s${index}@example.com` },
    subject: `Subject ${index}`,
    cc: [],
    bcc: [],
    attachments: [],
    labels: [],
    inReplyTo: null,
    aliasTag: null,
    snoozedUntil: null,
    references: [],
    headers: 'h'.repeat(600),
    date: '2026-11-14T01:08:57.000Z',
  });

  it('stays JSON a model reads: compacted, then cut to its head, with a marker', () => {
    const bounded = boundToolResult({ data: Array.from({ length: 20 }, (_, i) => email(i)) }, 4000);
    expect(bounded).not.toHaveProperty('preview');
    const data = (bounded as { data: unknown[] }).data;
    const records = data.filter((item) => typeof item === 'object') as Record<string, unknown>[];
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records[0]).toMatchObject({ id: 'e0', subject: 'Subject 0', cc: [] });
    expect(records[0]).not.toHaveProperty('_id');
    expect(records[0]).not.toHaveProperty('inReplyTo');
    expect(data.at(-1)).toMatch(/more items omitted/);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(4000);
  });

  it('drops only what holds nothing: an empty list is a reader’s "none"', () => {
    expect(compactToolResult({ data: [email(1)].map(({ headers: _, ...rest }) => rest) })).toEqual({
      data: [
        {
          id: 'e1',
          from: { name: 'Sender 1', address: 's1@example.com' },
          subject: 'Subject 1',
          cc: [],
          bcc: [],
          attachments: [],
          labels: [],
          references: [],
          date: '2026-11-14T01:08:57.000Z',
        },
      ],
    });
  });

  it('leaves a result that fits as the tool returned it, an empty table included', async () => {
    const table = {
      type: 'table',
      title: 'Empty',
      data: { headers: ['Name'], rows: [] },
      note: null,
    };
    expect(boundToolResult(table, 4000)).toBe(table);
    const wrapped = wrapToolsWithTruncation(
      {
        canvas: tool({ description: 'c', inputSchema: z.object({}), execute: async () => table }),
      },
      4000,
    );
    const out = await (wrapped.canvas.execute as (a: unknown, o: unknown) => Promise<unknown>)(
      {},
      {},
    );
    expect(out).toEqual(table);
    expect(clientToolResult(out)).toEqual(table);
  });
});
