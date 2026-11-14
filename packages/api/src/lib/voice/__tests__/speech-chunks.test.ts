import { describe, expect, it } from 'vitest';
import {
  MAX_REALTIME_DELEGATION_TEXT_CHARS,
  MAX_REALTIME_VERBATIM_SPANS,
} from '@kaana.ai/contracts';
import { SentenceChunker, verbatimSpans } from '../speech-chunks.js';

/**
 * How a delegated turn's answer becomes `delegation.reply` chunks (ADR 0041
 * §2): one per sentence, the last one held for `final`, and the exact spans
 * the voice must not paraphrase.
 */

function chunk(...deltas: string[]): { streamed: string[]; final: string[] } {
  const chunker = new SentenceChunker();
  const streamed = deltas.flatMap((delta) => chunker.push(delta));
  return { streamed, final: chunker.end() };
}

describe('sentences', () => {
  it('speaks each sentence once the next has begun, and holds the last for the final reply', () => {
    expect(chunk('Hola. ¿Qué ', 'tal? Muy bien', '.')).toEqual({
      streamed: ['Hola.'],
      final: ['¿Qué tal?', 'Muy bien.'],
    });
    expect(chunk('Uno. ', 'Dos. ', 'Tres. ')).toEqual({
      streamed: ['Uno.', 'Dos.'],
      final: ['Tres.'],
    });
  });

  it('never ends a sentence inside a number, an address or a URL', () => {
    expect(chunk('Cuesta 3.5 euros en example.com hoy.')).toEqual({
      streamed: [],
      final: ['Cuesta 3.5 euros en example.com hoy.'],
    });
  });

  it('reads no markdown aloud, and a line break ends a sentence', () => {
    expect(chunk('**Hecho**\n- `pan`\n- leche')).toEqual({
      streamed: ['Hecho'],
      final: ['pan', 'leche'],
    });
  });

  it('has nothing to say for an answer with no words', () => {
    expect(chunk('', '  ')).toEqual({ streamed: [], final: [] });
  });

  it('keeps every reply within the contract’s bound', () => {
    const long = `${'palabra '.repeat(2_000)}fin.`;
    const { streamed, final } = chunk(long);
    for (const part of [...streamed, ...final])
      expect(part.length).toBeLessThanOrEqual(MAX_REALTIME_DELEGATION_TEXT_CHARS);
    expect([...streamed, ...final].join(' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });
});

describe('verbatim spans', () => {
  it('marks numbers, times, prices, phones, codes, emails, URLs and names', () => {
    expect(verbatimSpans('Son las 10:30 y cuesta 12,50 €.')).toEqual(['10:30', '12,50 €']);
    expect(verbatimSpans('Llama al +34 600 123 456 o escribe a ana.lopez@example.com.')).toEqual([
      '+34 600 123 456',
      'ana.lopez@example.com',
    ]);
    expect(verbatimSpans('Tu código es AB12-CD y el pedido X7K9Q.')).toEqual(['AB12-CD', 'X7K9Q']);
    expect(verbatimSpans('Está en https://gemies.ai/docs/voice, mira.')).toEqual([
      'https://gemies.ai/docs/voice',
    ]);
    expect(verbatimSpans('He quedado con María López en la Calle Mayor 12.')).toEqual([
      'María López',
      'Calle Mayor',
      '12',
    ]);
    expect(verbatimSpans('Mañana viene Pedro.')).toEqual(['Pedro']);
  });

  it('marks nothing in plain words, nor the word a sentence starts with, nor a lone digit', () => {
    expect(verbatimSpans('Claro, te lo recuerdo mañana.')).toEqual([]);
    expect(verbatimSpans('Tengo 3 ideas.')).toEqual([]);
  });

  it('are exact substrings, in order, without overlap or repeats, at most the contract’s count', () => {
    const text = 'El 1 de mayo, el 2 de mayo, el 10 de mayo y el 10 de mayo otra vez.';
    const spans = verbatimSpans(text);
    expect(spans).toEqual(['10']);
    const many = Array.from({ length: 50 }, (_, index) => `${index + 10}`).join(', ');
    const capped = verbatimSpans(`Números: ${many}.`);
    expect(capped.length).toBeLessThanOrEqual(MAX_REALTIME_VERBATIM_SPANS);
    for (const span of capped) expect(`Números: ${many}.`).toContain(span);
    const url = verbatimSpans('Mira https://example.com/a?b=12 ya.');
    expect(url).toEqual(['https://example.com/a?b=12']);
  });
});
