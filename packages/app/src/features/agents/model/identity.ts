/**
 * Rendering an agent, whose identity lives in Oxy or (a gemie with no Oxy account) on its own row.
 *
 * `Agent.name`, `.handle` and `.color` are nullable because the API resolves
 * them through a batched Oxy lookup that FAILS OPEN: an account it cannot
 * resolve — deleted, federated, or unreachable because Oxy is having a bad
 * afternoon — arrives as three nulls, and the listing still renders because the
 * tagline, the rating and the price are Alia's own.
 *
 * `color` has no helper here because it needs none that is about IDENTITY: it is
 * the gemie's colour, its account's, and what to do with an unknown one is a
 * RENDERING decision, made once in `readAgentCharacter` (`@gemies/sdk`), which
 * paints the agent's `character` in it.
 *
 * Every surface therefore needs the same fallback, and it is here rather than
 * inlined at each one: two screens disagreeing about what an unresolved agent
 * is called is a difference nobody reports.
 */

import type { Agent } from '@/shared/contracts/agents';
import { agentHandle } from '@/shared/routing/agent-address';

/** The identity fields any renderable agent-like row carries. */
type AgentIdentityFields = Pick<Agent, 'name' | 'handle'>;

/**
 * The name to SHOW. Never empty.
 *
 * The handle is tried before the generic word because it is still the agent's
 * own identity — an account Oxy resolved only partially is better rendered as
 * `@researcher` than as "Agent".
 */
export function agentDisplayName(agent: AgentIdentityFields): string {
  return agent.name?.trim() || agent.handle?.trim() || 'Agent';
}

/** Whether a query matches what a person can actually see of this agent. */
export function agentIdentityMatches(agent: AgentIdentityFields, query: string): boolean {
  const lowered = query.toLowerCase();
  return (
    agentDisplayName(agent).toLowerCase().includes(lowered) ||
    agentHandle(agent).toLowerCase().includes(lowered)
  );
}

/**
 * Whether the gemie has an Oxy account of its own (Gemies ADR 0036). One with none — an external
 * agent, a CLI paired from its owner's computer — has a name and a colour but no handle, no page,
 * no connected accounts, inbox or background work, and is its owner's alone: a screen offers it
 * none of those, and never shares or publishes it.
 */
export function hasOxyAccount(agent: Pick<Agent, 'identity'>): boolean {
  return agent.identity.source === 'oxy';
}
