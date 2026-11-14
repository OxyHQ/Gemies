import type { AvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import type { GemieAgentProfile } from '../runtime/agents';
import type { Message } from '../runtime/types';
import { readAgentCharacter } from './agent-character';
import { ALIA_AVATAR } from './alia-character';
import { ALIA_GEMIE_ID } from './alia-gemie';

/** Somebody in the conversation who answers: its lead, a group's member, or a gemie of a conversation between gemies. */
export interface GemieParticipant {
  id: string;
  name: string;
  handle?: string;
  /** The character it is drawn as, painted in its colour. */
  character: AvatarCharacter;
  /** Its colour: its Oxy account's (`User.color`, a Bloom preset key or any hex). */
  color?: string;
}

/** The conversation's lead: who greets, whose name is on the composer, who the header shows first. */
export interface GemieLead extends GemieParticipant {
  /** Alia herself, rather than an agent the chat was opened on. */
  isAlia: boolean;
  /** The agent's own greeting; Alia greets with the chat's labels. */
  greeting?: string;
  /** The agent's own starters, offered over the composer of an empty chat. */
  starters: Array<{ title: string; prompt: string }>;
}

/** Who is in the conversation, as the header draws it: the lead, then whoever has joined. */
export interface GemieChatParticipants {
  lead: GemieLead;
  /** The others in it: a group's other members, or the gemie the lead talks to. */
  joined: GemieParticipant[];
  /**
   * The conversation they are in, so the header can say live what one of them is doing
   * ("Pepe is typing…") in place of their names. Absent before the first turn creates one.
   */
  conversationId?: string;
}

/**
 * The participants of a GROUP conversation: nobody leads it, so the first member stands in as the
 * lead the chat's frame needs (the header lists them all) and the rest are already in it. Members
 * do not join through flights: they were there when the conversation was made.
 */
export function groupParticipants(members: readonly GemieParticipant[]): GemieChatParticipants {
  const [first, ...rest] = members;
  if (first === undefined) return { lead: ALIA_LEAD, joined: [] };
  return { lead: { ...first, isAlia: false, starters: [] }, joined: rest };
}

/** Alia as a lead. */
export const ALIA_LEAD: GemieLead = {
  id: 'alia',
  name: 'Alia',
  handle: 'alia',
  character: ALIA_AVATAR,
  isAlia: true,
  starters: [],
};

/** The lead of a chat: the agent it was opened on (`agent={{ id }}`), or Alia. */
export function leadOf(profile: GemieAgentProfile | null | undefined): GemieLead {
  if (!profile) return ALIA_LEAD;
  return {
    id: profile.id,
    name: profile.name,
    handle: profile.handle,
    character: readAgentCharacter(profile.character, profile.color),
    color: profile.color,
    isAlia: false,
    greeting: profile.greeting,
    starters: profile.starters,
  };
}

/**
 * The character a gemie is drawn as, from what a message carries of it. Alia's gemie carries no
 * character of its own (her look is the app's, `ALIA_AVATAR`), so she is drawn as herself rather
 * than as the default a missing character falls back to.
 */
export function agentCharacterOf(agentInfo: NonNullable<Message['agentInfo']>): AvatarCharacter {
  return agentInfo.id === ALIA_GEMIE_ID
    ? ALIA_AVATAR
    : readAgentCharacter(agentInfo.character, agentInfo.color);
}

/** A gemie as a message carries it (`agentInfo`). */
export function participantOf(agentInfo: NonNullable<Message['agentInfo']>): GemieParticipant {
  return {
    id: agentInfo.id,
    name: agentInfo.name,
    handle: agentInfo.handle,
    character: agentCharacterOf(agentInfo),
    color: agentInfo.color,
  };
}
