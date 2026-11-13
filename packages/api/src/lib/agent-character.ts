/**
 * A gemie's character: its shape and features, and no colour of its own.
 *
 * A gemie is an Oxy `bot` account, and its colour is that account's `User.color` (a Bloom preset
 * key, `lib/agent-color.ts`): the avatar's body, the chat's tint, the sidebar, the catalogue and
 * every other app are painted in it. So the character this service stores (`agents.character`) and
 * puts on the account (`users.character`) is what the gemie looks like apart from its colour: a
 * `shape` or a `preset`, `eyes`, `eyewear`, `accessory` and `eyeSpacing`. A client paints it in the
 * account's colour (`readAgentCharacter` in `@gemies/sdk`, over Bloom's `avatarCharacterInColor`).
 *
 * A paint in a character (`color`, a named paint, or `bodyColor`, a free hex) would be a second
 * colour free to disagree with the account's, which is what it was until migration 0147 removed
 * them. A write that carries one is refused rather than stripped: it comes from a client that still
 * edits a paint, and saving the rest of its character would silently drop the colour it showed.
 */

import { parseAvatarCharacter, type AvatarCharacter } from '@oxy.so/contracts';

/** The keys of a character that would give it a colour of its own. */
const PAINT_KEYS = ['color', 'bodyColor'] as const;

/** Whether a character carries a paint of its own. */
function hasPaint(character: AvatarCharacter): boolean {
  return PAINT_KEYS.some((key) => character[key] !== undefined);
}

/**
 * The character a client writes, checked: Oxy's shape (`parseAvatarCharacter`) and no paint.
 * `null` for anything else.
 */
export function parseGemieCharacter(value: unknown): AvatarCharacter | null {
  const character = parseAvatarCharacter(value);
  return character === null || hasPaint(character) ? null : character;
}

/**
 * A character as a gemie keeps it: without a paint. For the look picked for a new gemie from its
 * handle (`avatarCharacterFor`, which also picks a paint) and the look its Oxy account already
 * carries, which a bot written before its colour was its account's may still paint.
 */
export function gemieCharacterOf({
  color: _color,
  bodyColor: _bodyColor,
  ...parts
}: AvatarCharacter): AvatarCharacter {
  return parts;
}
