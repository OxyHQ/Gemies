/**
 * What a turn knows about the person and the actor before it is answered:
 * memory, Oxy profile, entitlements, the gemie, skills and recalled memories.
 *
 * Extracted from `buildChatRequestContext` (ADR 0017 §3) so that a typed turn
 * and a voice call read the SAME inputs from an identity, and voice never
 * drifts from chat. The chat handler still owns everything that is about the
 * HTTP request — body validation, credit reservation, the refusals it writes;
 * this module owns only the reads, and takes an identity instead of `req`.
 *
 * The module paths below are the ones `request-context.ts` imported inline,
 * so the suites that mock those seams keep intercepting them.
 */

import { getDb } from '../../db/index.js';
import { findAgentSkills } from '../../db/agents/agentRepository.js';
import { findUserMemory, type UserMemoryProfile } from '../../db/memory/userMemoryRepository.js';
import { oxy } from '../oxy.js';
import { loadTurnAgent } from '../agent-account.js';
import { loadAliaGemie } from '../alia-gemie.js';
import type { HydratedAgent } from '../agent-identity.js';
import { log } from '../logger.js';
import { getUserEntitlements, type Entitlements } from '../plan-access.js';
import { buildSkillRuntime, type SkillRuntime } from '../skills/runtime.js';
import type { OxyUserProfile } from '../system-prompt-builder.js';

/** Who the turn is for. */
export interface TurnIdentity {
  /** The authenticated person, or `undefined` for an anonymous caller. */
  readonly oxyUserId: string | undefined;
  readonly accessToken?: string;
  /** A person's own session (not a service acting for them). */
  readonly isDirectUserSession: boolean;
  /** An exact gemie selector the caller already validated, or `undefined` for the default (Alia). */
  readonly requestedAgentId?: string;
  /** The app the turn comes from, by its verified app assertion (`lib/app-surface.ts`), or `null`. */
  readonly surfaceApplicationId: string | null;
  /** `false` when the person turned personalization off for this turn: no memory profile is read. */
  readonly loadUserMemory?: boolean;
}

/** What `loadTurnAgent` answered (Alia's gemie when nothing was named), plus the failure this module adds. */
export type TurnAgentResolution =
  | Awaited<ReturnType<typeof loadTurnAgent>>
  | { readonly kind: 'resolution_unavailable' };

export interface PrefetchedTurnInputs {
  readonly userMemory: UserMemoryProfile | null;
  readonly oxyUser: OxyUserProfile | null;
  readonly entitlements: Entitlements | null;
  readonly turnAgent: TurnAgentResolution;
}

/** The skill runtime of a turn that has none. */
export const EMPTY_SKILL_RUNTIME: SkillRuntime = {
  index: '',
  active: '',
  tools: {},
  agentScoped: false,
  candidateIds: [],
  activated: () => [],
};

/**
 * The independent reads, in parallel. Each fails soft except the gemie: every
 * turn has one — the one it named, or Alia's (ADR 0034 §4) — and one that
 * cannot be loaded is `resolution_unavailable`, never somebody else: a turn
 * that named an agent is never answered by Alia, nor Alia's by a stranger.
 */
export async function prefetchTurnInputs(
  identity: TurnIdentity,
  /** The gemie, when the caller already started resolving it (the chat admission waits on it alone). */
  gemie: Promise<TurnAgentResolution> = resolveTurnGemie(identity),
): Promise<PrefetchedTurnInputs> {
  const { oxyUserId, isDirectUserSession } = identity;
  const [userMemory, oxyUser, entitlements, turnAgent] = await Promise.all([
    oxyUserId !== undefined && identity.loadUserMemory !== false
      ? findUserMemory(getDb(), oxyUserId)
          .then((memory) => memory ?? null)
          .catch(() => null)
      : Promise.resolve(null),

    // The profile is an HTTP call to Oxy: bounded, so a slow Oxy never holds a turn.
    isDirectUserSession && oxyUserId !== undefined
      ? Promise.race<OxyUserProfile | null>([
          oxy.users.get(oxyUserId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]).catch(() => null)
      : Promise.resolve<OxyUserProfile | null>(null),

    oxyUserId !== undefined
      ? getUserEntitlements(oxyUserId).catch(() => null)
      : Promise.resolve(null),

    gemie,
  ]);
  return { userMemory, oxyUser, entitlements, turnAgent };
}

/**
 * The gemie a turn is for. Named: authorised by `loadTurnAgent`, which is the
 * same rule as opening it. Not named: the default gemie, Alia, whom everybody
 * may use. A name without a person to authorise it is out of reach.
 */
export async function resolveTurnGemie(identity: TurnIdentity): Promise<TurnAgentResolution> {
  const { requestedAgentId, oxyUserId } = identity;
  try {
    if (requestedAgentId === undefined) return { kind: 'agent', agent: await loadAliaGemie() };
    if (oxyUserId === undefined) return { kind: 'unavailable', reason: 'out_of_reach' };
    return await loadTurnAgent(getDb(), {
      agentId: requestedAgentId,
      oxyUserId,
      accessToken: identity.accessToken,
      surfaceApplicationId: identity.surfaceApplicationId,
    });
  } catch (err: unknown) {
    log.v1.warn({ err, agentId: requestedAgentId }, 'Could not resolve the turn gemie');
    return { kind: 'resolution_unavailable' };
  }
}

/**
 * The skills this turn may reach, after the gemie is known: the person's own
 * assistant (`reach = 'person'`) reaches the skills the person installed, any
 * other gemie the skills linked to it. `null` when the runtime cannot be built
 * (the turn goes on without skills).
 */
export async function buildTurnSkills(input: {
  readonly oxyUserId: string;
  readonly linkedAgent: HydratedAgent;
  readonly selectedSkillNames?: string[] | null;
}): Promise<SkillRuntime | null> {
  const { oxyUserId, linkedAgent } = input;
  const personAssistant = linkedAgent.reach === 'person';
  try {
    return await buildSkillRuntime({
      db: getDb(),
      oxyUserId,
      selectedNames: input.selectedSkillNames,
      agentSkillIds: personAssistant
        ? []
        : (await findAgentSkills(getDb(), linkedAgent.id)).map((ref) => ref._id),
      includeUserInstalled: personAssistant,
    });
  } catch (err) {
    // The agent-skill lookup is inside the guard too: a fault there is a turn
    // without skills, not a turn that throws after credits were reserved.
    log.v1.warn({ err }, 'Skill runtime unavailable for this turn');
    return null;
  }
}
