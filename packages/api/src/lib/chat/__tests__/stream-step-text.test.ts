/**
 * A reply written over several steps reads as one reply: each step's words start a new paragraph.
 * A gemie narrated before a tool ("Dame un segundo y lo reviso de verdad.") and answered after it
 * ("Tienes 20 emails…"), and the stored reply read "…de verdad.Tienes 20 emails…" (2026-11-14).
 */

import { describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { child };
});

vi.mock('../../logger.js', () => ({
  log: {
    v1: logMocks.child,
    chat: logMocks.child,
    general: logMocks.child,
    agents: logMocks.child,
    credits: logMocks.child,
    providers: logMocks.child,
  },
}));
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');

const text = (value: string) => ({ type: 'text-delta', id: 't', text: value });
const step = { type: 'finish-step', usage: {} };
const finish = { type: 'finish', finishReason: 'stop', totalUsage: {} };

function shown(written: readonly string[]): string {
  return written
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? '')
    .join('');
}

describe('runStream and the words of several steps', () => {
  it('starts each step’s words as a new paragraph, live and in the stored reply', async () => {
    const result = await runChunks([
      text('Dame un segundo y lo reviso '),
      text('de verdad.'),
      step,
      text('Tienes **20 emails** '),
      text('sin leer.'),
      finish,
    ]);
    const reply = 'Dame un segundo y lo reviso de verdad.\n\nTienes **20 emails** sin leer.';
    expect(shown(result.written)).toBe(reply);
    expect(result.assistantResponse).toBe(reply);
  });

  it('adds nothing where the words already break, or within a step', async () => {
    const result = await runChunks([text('Uno.\n'), step, text('Dos'), text('tres.'), finish]);
    expect(result.assistantResponse).toBe('Uno.\nDostres.');
  });

  it('adds nothing before the first words of a reply', async () => {
    const result = await runChunks([step, text('Hola.'), finish]);
    expect(result.assistantResponse).toBe('Hola.');
  });
});
