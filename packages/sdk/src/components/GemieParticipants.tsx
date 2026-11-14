/**
 * The conversation's participants: Bloom's `AgentProfile` with `[lead, ...joined]` (ADR 0020 §7).
 *
 * Who is in a conversation is known when it opens: its lead, a group's members, or the two gemies
 * of a conversation between gemies (ADR 0041). Nobody joins a chat mid-turn any more — a gemie that
 * wants something from another writes to it in their own conversation — so the header is drawn,
 * never joined. A GROUP's first message flies its members' avatars out of the empty chat into it
 * (`groupFirstSend`), Bloom's own multi-agent choreography.
 *
 * This is the ONLY file that draws `AgentProfile` (`one-thread.test.tsx` holds it), so the header
 * of the sheet, the screen and the Alia app are one header.
 */

import { AgentProfile } from '@oxy.so/bloom/agent-reply';
import { type AvatarFlightSpec, avatarJoinFlights } from '@oxy.so/bloom/avatar-flight';
import { memo, useMemo } from 'react';
import { ANCHORS, useGemieFlights } from '../lib/flights';
import type { GemieChatParticipants, GemieParticipant } from '../lib/participants';
import { useConversationActivityText } from '../realtime/activity-text';

/** How long the answering member's avatar takes to land on its reply. */
const REPLY_LANDING_MS = 800;

/**
 * A group's first message, as Bloom's multi-agent chat flies it: the member that answers first
 * lands on its reply (`reply:<id>`), the others merge into the header's participants. Each leaves
 * the `empty:<id>` anchor the group's welcome draws.
 */
export function groupFirstSend(members: readonly GemieParticipant[]): AvatarFlightSpec[] {
  const [responder, ...waiting] = members;
  if (responder === undefined) return [];
  return [
    {
      key: responder.id,
      character: responder.character,
      from: `empty:${responder.id}`,
      to: ANCHORS.reply(responder.id),
      duration: REPLY_LANDING_MS,
    },
    ...avatarJoinFlights(waiting, {
      from: (member) => `empty:${member.id}`,
      to: ANCHORS.profile,
      character: (member) => member.character,
    }),
  ];
}

export interface GemieParticipantsProps {
  participants: GemieChatParticipants;
  /** Pressing the profile. Omitted, every avatar in it waves. */
  onPress?: () => void;
}

const noop = () => undefined;

/**
 * The header's participants: the lead's avatar above its name, with the others in the conversation
 * ("Pepe + Lumen"). Place it in the chat's chrome; it is the conversation's title.
 */
export const GemieParticipants = memo(function GemieParticipants({
  participants,
  onPress,
}: GemieParticipantsProps) {
  const flights = useGemieFlights();
  // WhatsApp's header: the names give way to what one of them is doing, while they do it.
  const activity = useConversationActivityText(participants.conversationId);
  const agents = useMemo(
    () =>
      [participants.lead, ...participants.joined].map((agent) => ({
        id: agent.id,
        name: agent.name,
        avatar: agent.character,
      })),
    [participants],
  );
  return (
    <AgentProfile
      agents={agents}
      {...(activity === null ? {} : { label: activity })}
      onPress={onPress ?? noop}
      avatarRef={flights?.anchor(ANCHORS.profile)}
      avatarHidden={flights?.isLanding(ANCHORS.profile)}
    />
  );
});
