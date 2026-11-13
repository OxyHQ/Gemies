/**
 * Text somebody else wrote, made into plain text before Gemies shows it or hands it to a model.
 *
 * A public MCP registry's names and descriptions, and an MCP server's tool descriptions, are written
 * by whoever published the server. They are shown in the store and, for tools, read by the model, so
 * they are where a hidden instruction would be planted ("tool poisoning"). Nothing here executes
 * them; what this removes is what makes such text invisible or outsized:
 *
 * - characters a person never sees but a model reads: zero-width and bidirectional controls, the
 *   Unicode tag block (U+E0000–U+E007F, which spells ASCII invisibly), soft hyphens, C0/C1 controls;
 * - markup-looking tags (`<IMPORTANT>`, `<system>`), which only a model would read as structure;
 * - length: a description longer than `maxLength` is cut, so no catalogue text can crowd a prompt.
 *
 * Whitespace is collapsed to single spaces. The result is still somebody else's words: the system
 * prompt tells the model a connector's tools are data, never instructions (`prompts/base.md`).
 */

/**
 * The code points removed as invisible, as ranges: C0/C1 controls (tab and line breaks kept, then
 * collapsed), the soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul and Khmer
 * fillers, Mongolian selectors, zero-width and bidirectional controls, word joiners and invisible
 * operators, variation selectors, the BOM, interlinear annotations and the Unicode tag block. Built
 * from numbers so the source holds no invisible character itself.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
);

/** A tag-shaped run (`<system>`, `</IMPORTANT>`, `<br/>`), not a lone comparison like `a < b`. */
const TAG = /<\/?[a-z][a-z0-9_-]{0,40}(\s[^<>]{0,200})?\/?>/gi;

export function untrustedPlainText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  const text = input
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(TAG, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Whether a text carried anything {@link untrustedPlainText} removes as invisible. */
export function hasInvisibleText(input: string): boolean {
  INVISIBLE.lastIndex = 0;
  const found = INVISIBLE.test(input);
  INVISIBLE.lastIndex = 0;
  return found;
}
