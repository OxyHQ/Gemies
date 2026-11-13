import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';

/**
 * Alia's likeness in Bloom's character renderer: the six-lobed flower in orchid, plain oval
 * eyes, nothing on its head. It is `blue_beret` with the hat taken off and the paint changed,
 * so Bloom retargets that preset's animation onto it; change it here and nowhere else.
 *
 * Every other gemie is painted in its Oxy account's colour and carries no paint of its own
 * (`readAgentCharacter`). Alia is the one exception, and only because her gemie has no Oxy account
 * yet (`agents.oxy_account_id` is `pending-oxy-account:alia` until Oxy gives her one, ADR 0034
 * phase 2): when it exists, her colour is its `color` and the paint here goes.
 *
 * A module of its own, without React.
 */
export const ALIA_AVATAR: AvatarCharacter = {
  preset: 'blue_beret',
  accessory: 'none',
  color: 'orchid',
};
