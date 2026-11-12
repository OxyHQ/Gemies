/**
 * Alia's gemie, loaded (ADR 0034 §2, §4).
 *
 * A turn, a conversation, a call, a channel message or a task that names no gemie is Alia's: she is
 * the default gemie until a person or an app can choose another (ADR 0034 §4). This module is that
 * rule's one implementation, and it returns the ROW — every decision about how her turn runs is read
 * from the row's attributes (`memoryStore`, `reach`, `mailbox`, `taskAuthority`, `capabilityGrants`),
 * never from her id.
 *
 * Cached for a minute per instance, like an agent's availability: the row changes when Oxy's
 * organization edits her, and a turn must not pay a database round trip and an Oxy lookup to learn who
 * Alia is.
 */

import { findAgentById } from '../db/agents/agentRepository.js';
import { getDb } from '../db/index.js';
import { ALIA_GEMIE_ID } from '../domain/alia-gemie.js';
import { attachAgentIdentity, type HydratedAgent } from './agent-identity.js';
import { TTLCache } from './ttl-cache.js';

const ALIA_GEMIE_TTL_MS = 60_000;

const cache = new TTLCache<HydratedAgent>({ ttlMs: ALIA_GEMIE_TTL_MS, maxSize: 1 });

/**
 * Alia's row with her Oxy identity attached.
 *
 * Throws when the row is missing: migration 0135 seeds it, so its absence is a broken deployment, and
 * answering a turn as somebody else would be the wrong answer rather than a degraded one.
 */
export async function loadAliaGemie(): Promise<HydratedAgent> {
  return cache.getOrLoad(ALIA_GEMIE_ID, async () => {
    const row = await findAgentById(getDb(), ALIA_GEMIE_ID);
    if (row === null) throw new Error('Alia’s gemie is missing; migration 0135 seeds it');
    return attachAgentIdentity(row);
  });
}

/** Test seam: forget the cached row. */
export function clearAliaGemieCache(): void {
  cache.clear();
}
