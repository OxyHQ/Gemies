/**
 * The colour a gemie is drawn in — its Oxy account's, and nothing else.
 *
 * A gemie is an Oxy `bot` account, and its colour lives where its name and handle do: on that
 * account, in `User.color`. This service stores no colour for it, exactly as it stores no name, and
 * its character carries none (`lib/agent-character.ts`): the avatar's body, the chat's tint, the
 * sidebar, the catalogue and every other app paint a gemie in its account's colour.
 *
 * ## The vocabulary is Oxy's, which takes it from Bloom
 *
 * `User.color` holds a Bloom colour preset KEY — `"blue"`, `"lagoon"`, `"bronze-neon"` — never a hex.
 * Oxy's `users_color_check` accepts every preset in `USER_PROFILE_COLOR_PRESETS`, which
 * `@oxy.so/contracts` generates from Bloom's registry, and its write policy (`utils/profileColor.ts`
 * there) refuses the gated ones on an account that has no claim to them: a brand preset (`oxy`,
 * `faircoin`) is its own account's, and `mono` is a personal benefit a bot never holds. What a bot
 * may be given is therefore exactly `FREE_USER_PROFILE_COLOR_PRESETS`, and it is imported rather
 * than restated, so the colours this service offers and the editor's picker (which imports the same
 * list) are the ones Oxy saves, now and after Bloom adds one.
 *
 * ## It proposes, and Oxy decides
 *
 * A colour is written to Oxy and checked there: this list is what a new gemie may be OFFERED
 * (`POST /agents/generate`, the chat tool that creates one, an external agent's account). A colour
 * already stored is never re-validated here; a legacy hex an old account still carries renders as
 * its seed.
 */

import { FREE_USER_PROFILE_COLOR_PRESETS } from '@oxy.so/contracts';

/** The colours a gemie may be given: every preset Oxy accepts on a bot account. */
export const AGENT_COLORS = FREE_USER_PROFILE_COLOR_PRESETS as unknown as readonly [
  AgentColor,
  ...AgentColor[],
];

export type AgentColor = (typeof FREE_USER_PROFILE_COLOR_PRESETS)[number];

export function isAgentColor(value: unknown): value is AgentColor {
  return typeof value === 'string' && (AGENT_COLORS as readonly string[]).includes(value);
}

/**
 * A colour for a gemie whose proposed one was not offerable.
 *
 * Derived from the proposed handle rather than random, so regenerating the same gemie twice proposes
 * the same colour and the person is not shown a value that changes under them between two identical
 * requests. The sum is over code units, which is stable across runtimes in a way `Math.random` and
 * hash-map iteration order are not.
 */
export function agentColorFor(seed: string): AgentColor {
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum = (sum + seed.charCodeAt(i)) % 1_000_003;
  return AGENT_COLORS[sum % AGENT_COLORS.length];
}
