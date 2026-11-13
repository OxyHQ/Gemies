import { agentOpensOn } from './agent-availability.js';

/** What the unattended rule reads of an agent. */
export interface UnattendedAgent {
  readonly oxyAccountId: string;
  readonly ownerOxyAccountId: string | null;
  readonly access: string;
  readonly status: string;
}

/**
 * Whether an agent may work for a person who is not present — and, separately, whether we know.
 * Shared by automations (creating one and dispatching one, so the two cannot disagree about what
 * was allowed) and by a connected account's turns (ADR 0035), which arrive with no person present.
 *
 * `author` is listing metadata and never authority (`docs/agents.md`). Unattended work has no
 * bearer to ask Oxy about membership with, so the rule is the part of `canReachAgent` that needs
 * none: the person's own agent (its reconciled Oxy owner), or a public, active marketplace agent. A
 * private agent shared by membership fails closed.
 *
 * Unattended work is in no app, so an agent Oxy confines to an app never does it (ADR 0021) — asked
 * of Oxy like every other reach; `identity_unavailable` when Oxy could not answer.
 */
export async function unattendedReach(
  agent: UnattendedAgent,
  personAccountId: string,
): Promise<'reachable' | 'out_of_reach' | 'identity_unavailable'> {
  const who =
    agent.ownerOxyAccountId === personAccountId ||
    (agent.access === 'public' && agent.status === 'active');
  if (!who) return 'out_of_reach';
  return agentOpensOn(agent.oxyAccountId, null);
}

/** {@link unattendedReach} for an automation: anything but a yes refuses. */
export async function mayRunForAutomationOwner(
  agent: UnattendedAgent,
  ownerAccountId: string,
): Promise<boolean> {
  return (await unattendedReach(agent, ownerAccountId)) === 'reachable';
}
