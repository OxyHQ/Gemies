/**
 * The colour a gemie is drawn in — where its identity lives, and nowhere else.
 *
 * A gemie is an Oxy `bot` account, and its colour lives where its name and handle do: on that
 * account, in `User.color`. This service stores no colour for it, exactly as it stores no name, and
 * its character carries none (`lib/agent-character.ts`): the avatar's body, the chat's tint, the
 * sidebar, the catalogue and every other app paint a gemie in its account's colour. A gemie with no
 * Oxy account (ADR 0036, an external agent) keeps its colour on its row (`local_color`), in the same
 * vocabulary and checked by {@link isAgentColor} when its owner changes it.
 *
 * ## Any colour: a Bloom preset key or a hex
 *
 * `User.color` holds a Bloom colour preset KEY — `"blue"`, `"lagoon"` — or any hex colour
 * (`"#ff8b67"`), both first-class: Oxy's `users_color_check` stores either and its write policy
 * accepts either (a gated preset aside: a brand preset is its own account's, `mono` a personal
 * benefit), and Bloom paints a gemie in either (`avatarCharacterInColor`). The gemie editor's picker
 * is free — any colour — and writes it to the account with the owner's own credential.
 *
 * ## What this service offers
 *
 * A new gemie is OFFERED a colour by name (`POST /agents/generate`, the chat tool that creates one;
 * an external agent starts with its CLI's, `EXTERNAL_AGENT_CLI_COLORS`): the presets Oxy accepts on
 * a bot, `FREE_USER_PROFILE_COLOR_PRESETS`, imported rather than restated. A model may also answer a
 * hex, which is just as good a colour. A colour already stored is never re-validated here: Oxy
 * decides.
 */

import { FREE_USER_PROFILE_COLOR_PRESETS } from '@oxy.so/contracts';

/** The colours a new gemie is offered by name: every preset Oxy accepts on a bot account. */
export const AGENT_COLORS = FREE_USER_PROFILE_COLOR_PRESETS as unknown as readonly [
  AgentColor,
  ...AgentColor[],
];

export type AgentColor = (typeof FREE_USER_PROFILE_COLOR_PRESETS)[number];

/** A hex colour, `#rrggbb`: an account colour as good as a preset. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A colour a new gemie may be given: an offered preset, or any hex. */
export function isAgentColor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ((AGENT_COLORS as readonly string[]).includes(value) || HEX_COLOR.test(value))
  );
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
