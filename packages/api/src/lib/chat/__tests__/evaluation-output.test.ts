import { expect, it } from 'vitest';
import { drainEvaluationErrors, readEvaluationOutput } from './evaluation-output.js';

const suite = { kind: 'group-participation-evaluation', expectedSamples: 1 };
const progress = {
  kind: 'evaluation-case-progress',
  suite: suite.kind,
  label: 'synthetic-case',
  iteration: 1,
  passed: true,
  latencyMs: 12,
};
const summary = { kind: suite.kind, samples: 1, passed: 1, failed: 0, balanceMutations: false };
const bytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });

it('emits progress while the child stream is open; partial output never establishes acceptance', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let notify: (() => void) | undefined;
  const available = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const emitted: Record<string, unknown>[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const done = readEvaluationOutput(stream, suite, 1, (value) => {
    emitted.push(value);
    notify?.();
  });
  controller?.enqueue(bytes(progress));
  await available;
  expect(emitted).toEqual([progress]);
  controller?.close();
  expect(await done).toEqual({ summaryFound: false, suitePassed: false, progressCount: 1 });
});

it('handles chunk boundaries and the final summary without publishing raw child output', async () => {
  const row = bytes(progress);
  const emitted: Record<string, unknown>[] = [];
  const result = await readEvaluationOutput(
    streamOf(
      new TextEncoder().encode('raw provider secret\n'),
      row.slice(0, 5),
      row.slice(5),
      bytes(summary),
    ),
    suite,
    1,
    (value) => emitted.push(value),
  );
  expect(result).toEqual({ summaryFound: true, suitePassed: true, progressCount: 1 });
  expect(emitted).toEqual([progress, summary]);
});

it.each([
  [{ ...progress, headers: 'secret' }],
  [{ ...progress, suite: 'foreign' }],
  [{ ...progress, label: null }],
  [progress, progress],
  [summary, summary],
])('rejects unsafe, duplicate or unrelated progress: %o', async (...values) => {
  await expect(
    readEvaluationOutput(streamOf(...values.map(bytes)), suite, 1, () => {}),
  ).rejects.toThrow();
});

it.each([{ failed: 1 }, { samples: 0 }])(
  'partial pass cannot hide a failed or incomplete summary: %o',
  async (change) => {
    const result = await readEvaluationOutput(
      streamOf(bytes(progress), bytes({ ...summary, ...change })),
      suite,
      1,
      () => {},
    );
    expect(result.suitePassed).toBe(false);
  },
);

it('rejects oversized unterminated output and discards private stderr', async () => {
  await expect(
    readEvaluationOutput(streamOf(new Uint8Array(1024 * 1024 + 1)), suite, 1, () => {}),
  ).rejects.toThrow('bound');
  await expect(
    drainEvaluationErrors(streamOf(new TextEncoder().encode('private exception'))),
  ).resolves.toBeUndefined();
});
