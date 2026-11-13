/**
 * The actor Oxy is told acts, for a gemie — the ONE seam between Alia's gemie and Oxy's actor lanes.
 *
 * Oxy knows two actors that act for a person (`ActorRef` in `@oxy.so/contracts`):
 *
 *  - `{ type: 'agent', accountId }`: a gemie with its own `bot` account, acting for the requester or
 *    as itself (ADR 0015, ADR 0022).
 *  - `{ type: 'alia', ownerAccountId }`: Oxy's coordinator lane, where the person's own assistant
 *    acts with no account of its own. Oxy checks `ownerAccountId` against the requester and records no
 *    actor account (Oxy `firstPartyTasks.service.ts`), and the catalogue declares which tools admit it
 *    (the Nilo memory tools admit only it).
 *
 * A gemie with `reach = 'person'` (Alia) is the person's own assistant, so she speaks the coordinator
 * lane; every other gemie speaks as its account. That is decided here and nowhere else: outside the
 * Oxy client itself (`tools/oxy-services.ts`, whose person-lane helpers serve only her), no caller
 * writes `{ type: 'alia' }`.
 *
 * PENDING IN OXY (ADR 0034 phase 2, Oxy's contract): Oxy turns the coordinator lane into the Alia
 * gemie's own account. When that ships, this function is the one place that changes, and
 * `agents.oxy_account_id` of Alia's row gets her real account (it holds
 * `ALIA_PENDING_OXY_ACCOUNT_ID` until then).
 */

import type { ActorRef } from '@oxy.so/contracts';
import type { AgentReach, StoredAgentIdentity } from '../domain/agent.js';

/** What the seam reads of a gemie. */
export interface OxyActorGemie {
  readonly reach: AgentReach;
  readonly identity: StoredAgentIdentity;
}

/**
 * The Oxy `bot` account a gemie acts as, or `null` when it has none: a `local` gemie (ADR 0036, an
 * external agent) is nobody at Oxy, so every lane that needs an actor of its own — an Oxy task for
 * its work, its tools as itself, a connected account — is closed to it. What a gate asks before it
 * opens one.
 */
export function gemieOxyAccountId(gemie: {
  readonly identity: StoredAgentIdentity;
}): string | null {
  return gemie.identity.source === 'oxy' ? gemie.identity.oxyAccountId : null;
}

/** A gemie with no Oxy account reached a lane that acts as one: a gate before it is missing. */
export class GemieWithoutOxyAccountError extends Error {
  constructor() {
    super('A gemie with no Oxy account cannot act at Oxy');
    this.name = 'GemieWithoutOxyAccountError';
  }
}

/**
 * The account a gemie acts as inside Alia's own runtime (its tools, its memory, its follow-ups). A
 * `local` gemie never runs there — its turns are its daemon's (ADR 0030) and its gates refuse every
 * background lane — so arriving here with one is a fault, thrown rather than acted on as nobody.
 */
export function runtimeGemieAccountId(gemie: { readonly identity: StoredAgentIdentity }): string {
  const accountId = gemieOxyAccountId(gemie);
  if (accountId === null) throw new GemieWithoutOxyAccountError();
  return accountId;
}

/** The Oxy actor for `gemie` acting for `personAccountId`. */
export function oxyActorFor(gemie: OxyActorGemie, personAccountId: string): ActorRef {
  return gemie.reach === 'person'
    ? personAssistantActor(personAccountId)
    : { type: 'agent', accountId: runtimeGemieAccountId(gemie) };
}

/**
 * The actor of the person's own assistant, for the lanes that exist only for her and have no gemie
 * row at hand: a channel the person links so their assistant answers it, a canvas memory node (it
 * reads the person's Nilo memories), and the standing authority of a standing-authority gemie's task.
 */
export function personAssistantActor(personAccountId: string): ActorRef {
  return { type: 'alia', ownerAccountId: personAccountId };
}
