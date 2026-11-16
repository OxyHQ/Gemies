/**
 * How a delegated turn's answer becomes `delegation.reply` chunks (ADR 0041 §2,
 * Kaana ADR 0012 §1): one chunk per sentence, so the voice starts on the first
 * one, each with the spans it must say exactly (`verbatim`).
 *
 * Pure text in, text out: `call.ts` sends what this returns.
 */

import {
  MAX_REALTIME_DELEGATION_TEXT_CHARS,
  MAX_REALTIME_VERBATIM_SPAN_CHARS,
  MAX_REALTIME_VERBATIM_SPANS,
} from '@kaana.ai/contracts';

/**
 * A sentence ends at `.`, `!`, `?` or `…` (and their CJK forms) followed by
 * whitespace, or at a line break. A dot inside `3.5` or `example.com` ends
 * nothing: no whitespace follows it.
 */
const SENTENCE_END = /(?:[.!?…。！？]+["'”’)\]]*\s+|\n+)/g;

/** Markdown the voice would read out: emphasis, code fences and ticks, headings, list markers. */
function speakable(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut a run of text too long for one reply at the last space within the bound. */
function boundedParts(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_REALTIME_DELEGATION_TEXT_CHARS) {
    const window = rest.slice(0, MAX_REALTIME_DELEGATION_TEXT_CHARS);
    const cut = window.lastIndexOf(' ');
    const at = cut > 0 ? cut : MAX_REALTIME_DELEGATION_TEXT_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') parts.push(rest);
  return parts.filter((part) => part !== '');
}

/**
 * The answer's text as it streams, split into speakable sentences.
 *
 * The last complete sentence is held back until the next one completes or the
 * answer ends: the chunk that ends a delegation carries `final: true` and must
 * have text, and only the end of the stream says which sentence was the last.
 */
export class SentenceChunker {
  private buffer = '';
  private held: string | null = null;

  /** Text that arrived; returns the sentences that are now safe to speak. */
  push(delta: string): string[] {
    this.buffer += delta;
    const ready: string[] = [];
    let consumed = 0;
    SENTENCE_END.lastIndex = 0;
    for (
      let match = SENTENCE_END.exec(this.buffer);
      match;
      match = SENTENCE_END.exec(this.buffer)
    ) {
      const end = match.index + match[0].length;
      const sentence = speakable(this.buffer.slice(consumed, end));
      consumed = end;
      if (sentence === '') continue;
      if (this.held !== null) ready.push(...boundedParts(this.held));
      this.held = sentence;
    }
    this.buffer = this.buffer.slice(consumed);
    // A run with no sentence end still has to fit one reply.
    if (this.buffer.length > MAX_REALTIME_DELEGATION_TEXT_CHARS) {
      const parts = boundedParts(speakable(this.buffer));
      this.buffer = parts.pop() ?? '';
      if (this.held !== null) ready.push(...boundedParts(this.held));
      this.held = null;
      ready.push(...parts);
    }
    return ready;
  }

  /** The answer ended: what is left to speak, a sentence a part, the last being the final chunk. */
  end(): string[] {
    const parts = [...boundedParts(this.held ?? ''), ...boundedParts(speakable(this.buffer))];
    this.held = null;
    this.buffer = '';
    return parts;
  }
}

/**
 * What the voice must say exactly as written, most specific first: a URL, an
 * email address, a code (letters and digits mixed, or a run of capitals with
 * digits), a number with its unit or separators (a price, a time, a date, a
 * phone number, a street number), and a name (two or more capitalised words,
 * or one capitalised word that does not start the sentence).
 */
const VERBATIM_PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gu,
  /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}\b/gu,
  /\b(?=[\p{L}\p{N}-]*\p{N})(?=[\p{L}\p{N}-]*\p{Lu})[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+\b/gu,
  /\b(?=\p{L}*\p{N})(?=\p{N}*\p{Lu})[\p{Lu}\p{N}]{4,}\b/gu,
  /(?:[$€£¥]\s?)?\+?\d(?:[\d\s.,:/'-]*\d)?(?:\s?(?:%|[$€£¥]|(?:h|km|kg|m|cm|mm|ml|l|g|°C|°F)(?!\p{L})))?/gu,
  /\b\p{Lu}[\p{Ll}'’-]+(?:\s+(?:(?:de|del|la|van|von|da|di|le)\s+)?\p{Lu}[\p{Ll}'’-]+)+/gu,
  /(?<=[\p{Ll}\p{N},;:]\s+)\p{Lu}[\p{Ll}'’-]{2,}\b/gu,
];

/**
 * The `verbatim` spans of one reply: exact substrings of `text`, in order of
 * appearance, never overlapping, unique, each within the contract's bound, at
 * most the contract's count.
 */
export function verbatimSpans(text: string): string[] {
  const taken: Array<{ start: number; end: number; span: string }> = [];
  const overlaps = (start: number, end: number) =>
    taken.some((range) => start < range.end && range.start < end);
  for (const pattern of VERBATIM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const span = match[0].trim();
      if (span === '' || span.length > MAX_REALTIME_VERBATIM_SPAN_CHARS) continue;
      // A lone digit or a year-free single number of one character says itself.
      if (/^\d$/.test(span)) continue;
      const start = (match.index ?? 0) + match[0].indexOf(span);
      const end = start + span.length;
      if (overlaps(start, end)) continue;
      taken.push({ start, end, span });
    }
  }
  const spans: string[] = [];
  for (const { span } of taken.sort((a, b) => a.start - b.start)) {
    if (spans.includes(span)) continue;
    spans.push(span);
    if (spans.length === MAX_REALTIME_VERBATIM_SPANS) break;
  }
  return spans;
}
