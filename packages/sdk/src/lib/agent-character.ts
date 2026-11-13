import {
  avatarCharacterInColor,
  parseAvatarCharacter,
  type AvatarCharacter,
} from '@oxy.so/bloom/agent-avatar';

/**
 * The colour a gemie is painted in when its account's is not known: an account Oxy did not resolve,
 * an agent that has since been deleted. A Bloom colour preset key, like every account colour.
 */
export const DEFAULT_AGENT_COLOR = 'gray';

/**
 * The look of an agent whose own is not known: a server that does not send one yet, an agent that
 * has since been deleted, a stored character this Bloom cannot draw. One neutral character, the same
 * everywhere, so an unknown look is recognisably "not chosen" and never one that belongs to somebody.
 * Like every gemie's, it has no colour of its own.
 */
export const DEFAULT_AGENT_CHARACTER: AvatarCharacter = {
  shape: 'rounded_cube',
  eyes: 'oval',
  eyewear: 'none',
  accessory: 'none',
};

/** A character painted in an account's colour, or in the default one when that is not known. */
function painted(character: AvatarCharacter, color: string | null | undefined): AvatarCharacter {
  // Bloom leaves a character as it is for a colour it cannot resolve: the default goes on first and
  // the account's colour over it, so a character is always painted, and never in a stored paint.
  return avatarCharacterInColor(avatarCharacterInColor(character, DEFAULT_AGENT_COLOR), color);
}

/**
 * The look the server stores for a gemie (`agents.character`), as Bloom can draw it: its shape and
 * features, without a colour. What the agent editor edits and saves back. Bloom's own parser decides
 * what it can draw, and anything else is the default look.
 */
export function readAgentLook(value: unknown): AvatarCharacter {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_AGENT_CHARACTER;
  }
  try {
    const {
      color: _color,
      bodyColor: _bodyColor,
      ...look
    } = parseAvatarCharacter(painted(value as AvatarCharacter, null));
    return look;
  } catch {
    return DEFAULT_AGENT_CHARACTER;
  }
}

/**
 * The character a gemie is drawn as: its look (`readAgentLook`) painted in its account's colour
 * (`color`, `User.color`, a Bloom preset key). A gemie's colour is its Oxy account's and nothing
 * else, so `color` is required: every surface that draws a gemie has it beside the character.
 */
export function readAgentCharacter(
  value: unknown,
  color: string | null | undefined,
): AvatarCharacter {
  return painted(readAgentLook(value), color);
}
