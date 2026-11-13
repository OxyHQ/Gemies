/**
 * Gemies for tests: Alia's, configured exactly as migration 0135 seeds her row
 * (`aliaGemie.pgdb.test.ts` holds the two together), and an ordinary persona.
 */

import { ALIA_GEMIE_ID, ALIA_PENDING_OXY_ACCOUNT_ID } from '../../domain/alia-gemie.js';
import type { HydratedAgent } from '../../lib/agent-identity.js';

/** The configuration 0135 gives Alia's row, beside the defaults every other gemie keeps. */
export const ALIA_GEMIE_CONFIGURATION = {
  memoryStore: 'nilo',
  reach: 'person',
  mailbox: false,
  taskAuthority: 'standing',
  capabilityGrants: [
    'web',
    'artifacts',
    'memory',
    'messaging',
    'automation',
    'delegation',
    'agent',
  ],
  access: 'public',
  // Not listed until Oxy creates her account: a card with no identity would be a regression.
  isPublished: false,
  status: 'active',
} as const;

function baseGemie(): HydratedAgent {
  const now = new Date('2026-11-12T00:00:00.000Z');
  return {
    _id: 'gemie-1',
    id: 'gemie-1',
    identity: { source: 'oxy', oxyAccountId: 'bot-account-1' },
    ownerOxyAccountId: 'owner-1',
    character: { preset: 'blue_beret' },
    tagline: 'A gemie',
    description: 'A gemie for tests',
    starters: [],
    featureGates: {},
    primaryTools: [],
    author: 'owner-1',
    category: 'general',
    tags: [],
    rating: 0,
    reviewCount: 0,
    usageCount: 0,
    hireCount: 0,
    maxConcurrentThreads: 3,
    price: null,
    capabilityGrants: [],
    isFeatured: false,
    isTrending: false,
    isPublished: false,
    status: 'active',
    computerSource: 'alia',
    spaceId: null,
    access: 'private',
    memoryStore: 'gemie',
    reach: 'grants',
    mailbox: true,
    taskAuthority: 'session',
    systemPrompt: null,
    modelId: null,
    scheduleInterval: null,
    archetype: 'general',
    archetypeConfig: null,
    createdAt: now,
    updatedAt: now,
    name: 'Gemie',
    handle: 'gemie',
    color: null,
    authorName: null,
  };
}

/** Alia's gemie, hydrated the way `loadAliaGemie` returns it before Oxy knows her account. */
export function aliaGemie(): HydratedAgent {
  return {
    ...baseGemie(),
    _id: ALIA_GEMIE_ID,
    id: ALIA_GEMIE_ID,
    identity: { source: 'oxy', oxyAccountId: ALIA_PENDING_OXY_ACCOUNT_ID },
    ownerOxyAccountId: null,
    author: ALIA_PENDING_OXY_ACCOUNT_ID,
    character: { preset: 'blue_beret', accessory: 'none' },
    tagline: 'Oxy’s assistant, the same one for everybody.',
    category: 'assistant',
    ...ALIA_GEMIE_CONFIGURATION,
    capabilityGrants: [...ALIA_GEMIE_CONFIGURATION.capabilityGrants],
    name: null,
    handle: null,
  };
}

/** An ordinary gemie (a persona with its own account), with any field overridden. */
export function personaGemie(overrides: Partial<HydratedAgent> = {}): HydratedAgent {
  return { ...baseGemie(), ...overrides };
}
