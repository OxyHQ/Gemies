/**
 * A gemie bot's profile photo, drawn on the server: Bloom's `renderAgentAvatarPicture` (the
 * gemie's character in its colour, centred for Telegram's circular crop, on a much lighter tint of
 * that colour), rasterized to the JPEG Telegram takes for a static photo.
 *
 * The same rule as every app's (`readAgentCharacter` in `@gemies/sdk`): a character is painted in
 * the default colour first and in the account's over it, so an unknown or unresolved colour still
 * paints it, never in a stored paint.
 */

import {
  type AvatarCharacter,
  avatarCharacterInColor,
  parseAvatarCharacter,
  renderAgentAvatarPicture,
} from '@oxy.so/bloom/agent-avatar/svg';
import { renderSvgToJpeg } from '../browser/manager';

/** Telegram shows a bot's photo at up to 640 px. */
const PHOTO_SIZE = 640;
/** What a gemie is painted in when its account's colour is not known (`@gemies/sdk`). */
const DEFAULT_GEMIE_COLOR = 'gray';
/** The look of a gemie whose stored one cannot be drawn (`@gemies/sdk`). */
const DEFAULT_GEMIE_CHARACTER: AvatarCharacter = {
  shape: 'rounded_cube',
  eyes: 'oval',
  eyewear: 'none',
  accessory: 'none',
};

/** The stored look as Bloom can draw it, with no paint of its own (a gemie's colour is its account's). */
function lookOf(character: unknown): AvatarCharacter {
  try {
    const { color: _color, bodyColor: _bodyColor, ...look } = parseAvatarCharacter(character);
    return look;
  } catch {
    return DEFAULT_GEMIE_CHARACTER;
  }
}

export async function renderBotPhoto(character: unknown, color: string | null): Promise<Buffer> {
  const look = avatarCharacterInColor(lookOf(character), DEFAULT_GEMIE_COLOR);
  const svg = await renderAgentAvatarPicture(look, color, { size: PHOTO_SIZE });
  return renderSvgToJpeg(svg, PHOTO_SIZE);
}
