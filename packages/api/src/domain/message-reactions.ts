/**
 * Reactions to a message: the emoji a person puts under it, as a chat bubble shows them.
 *
 * A leaf module: it imports nothing (`db/__tests__/schemaModelIndependence.test.ts`).
 */

/** How many different emoji one person can leave on one message. */
export const MAX_REACTIONS_PER_MESSAGE = 6;
/** The longest a reaction may be: a flag, a family or a skin-toned gesture is several code points. */
const MAX_REACTION_LENGTH = 16;

/**
 * One emoji: a keycap, a flag, or a pictograph with its tones, variation selector and tag sequence,
 * joined to the next by a zero-width joiner. Never a joiner, a tone or a selector on its own.
 */
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}[\u{FE0F}\p{Emoji_Modifier}]*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?`;
const EMOJI = new RegExp(
  String.raw`^(?:[0-9#*]\u{FE0F}?\u{20E3}|\p{Regional_Indicator}{2}|${PICTOGRAPH}(?:\u{200D}${PICTOGRAPH})*)$`,
  'u',
);

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * A reaction as a client sends it: exactly one emoji, or `null` when it is not one. `👍🎉` is two:
 * taken as one, it held two reactions in one of the six places a message has.
 */
export function parseReaction(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const emoji = value.trim();
  if (emoji === '' || emoji.length > MAX_REACTION_LENGTH || !EMOJI.test(emoji)) return null;
  const [first, second] = graphemes.segment(emoji);
  return first !== undefined && second === undefined ? emoji : null;
}

/**
 * The reactions after the person toggles `emoji`: removed when it was there, else added, unless
 * they already hold the most a message takes (then the toggle changes nothing).
 */
export function toggleReaction(current: readonly string[], emoji: string): string[] {
  if (current.includes(emoji)) return current.filter((held) => held !== emoji);
  if (current.length >= MAX_REACTIONS_PER_MESSAGE) return [...current];
  return [...current, emoji];
}
