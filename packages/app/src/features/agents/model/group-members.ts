import type { GemieParticipant } from '@gemies/sdk';
import { readAgentCharacter } from '@gemies/sdk';
import type { Agent } from '@/shared/contracts/agents';
import { agentDisplayName } from './identity';
import { agentHandle } from '@/shared/routing/agent-address';

/**
 * The members of a group conversation as the chat draws them, in the order they answer; `undefined`
 * for a conversation that is not a group, or while the agents load.
 *
 * Read from the person's own agents; an id that is not among them (a member deleted since, or one
 * the person does not own) is left out rather than drawn as somebody else. The conversation is
 * still the group's however few are left: drawn as an ordinary chat, it greeted as Alia while what
 * the person sent went to the group's remaining members.
 */
export function groupMembersOf(
  memberAgentIds: readonly string[] | undefined,
  agents: readonly Agent[] | undefined,
): readonly GemieParticipant[] | undefined {
  if (memberAgentIds === undefined || memberAgentIds.length === 0 || agents === undefined) {
    return undefined;
  }
  return memberAgentIds.flatMap((id): GemieParticipant[] => {
    const agent = agents.find((candidate) => candidate._id === id);
    return agent
      ? [
          {
            id,
            name: agentDisplayName(agent),
            handle: agentHandle(agent),
            character: readAgentCharacter(agent.character, agent.color),
            color: agent.color ?? undefined,
          },
        ]
      : [];
  });
}
