/**
 * The person's own gemies, as a gemie finds them to write to one (ADR 0041): every active gemie
 * they made, their connected external agents included (a `local` gemie, ADR 0036) — not only the
 * public directory. Found by id, @handle or name, the way the person names them ("habla con
 * Claude").
 */

import { getDb } from '../../db/index.js';
import { listActiveAgentsByAuthor } from '../../db/agents/agentRepository.js';
import { agentPromptName, attachAgentIdentities } from '../agent-identity.js';

export interface OwnGemie {
  readonly id: string;
  readonly name: string;
  readonly handle: string | null;
  readonly tagline: string;
  /** A coding-agent CLI on the person's computer (ADR 0030), rather than a gemie Gemies runs. */
  readonly external: boolean;
}

/** The person's active gemies, newest first. */
export async function listOwnGemies(oxyUserId: string): Promise<OwnGemie[]> {
  const named = await attachAgentIdentities(await listActiveAgentsByAuthor(getDb(), oxyUserId));
  return named.map((gemie) => ({
    id: gemie._id,
    name: agentPromptName(gemie),
    handle: gemie.handle ?? null,
    tagline: gemie.tagline,
    external: gemie.identity.source === 'local',
  }));
}

/** Lower case, accents gone, spaces collapsed: what two spellings of a name share. */
function normalized(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a name, for "Claude" to find "Claude Code · desk". */
const wordsOf = (text: string) =>
  normalized(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The gemies a name means: its exact id, @handle or name when one matches; otherwise every gemie
 * whose name starts with those words. More than one is the caller's to tell apart, never a guess.
 */
export function gemiesNamed(gemies: readonly OwnGemie[], query: string): OwnGemie[] {
  const wanted = normalized(query);
  if (wanted === '') return [];
  const exact = gemies.filter(
    (gemie) =>
      gemie.id === query ||
      normalized(gemie.name) === wanted ||
      (gemie.handle !== null && normalized(gemie.handle) === wanted),
  );
  if (exact.length > 0) return exact;
  const words = wordsOf(query);
  return gemies.filter((gemie) => {
    const name = wordsOf(gemie.name);
    return words.every((word, index) => name[index]?.startsWith(word));
  });
}

/** The gemies a free-text search finds: every word in its name, handle or tagline. */
export function gemiesMatching(gemies: readonly OwnGemie[], query: string): OwnGemie[] {
  const words = wordsOf(query);
  if (words.length === 0) return [];
  return gemies.filter((gemie) => {
    const text = normalized(`${gemie.name} ${gemie.handle ?? ''} ${gemie.tagline}`);
    return words.every((word) => text.includes(word));
  });
}
