import { describe, expect, it, vi } from 'vitest';
import { emitEvaluationProgress } from './evaluation-progress.js';

describe('synthetic evaluation progress', () => {
  const suite = 'group-participation-evaluation';
  const row = { label: 'synthetic-case', iteration: 1, passed: true, latencyMs: 12 };
  it('writes a bounded partial record immediately without copying raw extras', () => {
    const write = vi.fn();
    emitEvaluationProgress(
      suite,
      { ...row, ...{ prompt: 'private', headers: 'secret', text: 'output' } },
      write,
    );
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? '')).toEqual({
      kind: 'evaluation-case-progress',
      suite,
      ...row,
    });
    expect(write.mock.calls[0]?.[0] ?? '').toMatch(/\n$/);
  });
  it('exposes only an allowlisted error category', () => {
    const write = vi.fn();
    emitEvaluationProgress(
      suite,
      { ...row, passed: false, errorCategory: 'raw provider credential' },
      write,
    );
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? '')).toMatchObject({
      passed: false,
      errorCategory: 'unclassified',
    });
  });
  it.each([
    { label: 'raw text with spaces' },
    { iteration: 0 },
    { iteration: 51 },
    { latencyMs: Infinity },
    { latencyMs: -1 },
  ])('rejects invalid metadata before writing: %o', (change) => {
    const write = vi.fn();
    expect(() => emitEvaluationProgress(suite, { ...row, ...change }, write)).toThrow(
      'Invalid synthetic',
    );
    expect(write).not.toHaveBeenCalled();
  });
});
