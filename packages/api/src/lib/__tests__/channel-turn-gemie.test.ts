/**
 * A connected account's turn is its gemie's (ADR 0035): `resolveTurnGemie` answers the gemie the
 * verified binding names, never Alia by default, and authorises it as unattended work — the
 * person's own gemie or a public active one, in no app — because no bearer is present.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  agents: new Map<string, Record<string, unknown>>(),
  opens: 'reachable' as 'reachable' | 'out_of_reach' | 'identity_unavailable',
  asked: [] as Array<{ account: string; surface: string | null }>,
}));

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: async (_db: unknown, id: string) => state.agents.get(id) ?? null,
  findAgentSkills: async () => [],
}));
vi.mock('../agent-availability.js', () => ({
  agentOpensOn: async (
    agent: { identity: { source: string; oxyAccountId?: string } },
    surface: string | null,
  ) => {
    state.asked.push({ account: agent.identity.oxyAccountId ?? '', surface });
    return state.opens;
  },
}));
vi.mock('../agent-identity.js', () => ({
  attachAgentIdentity: async (agent: Record<string, unknown>) => ({ ...agent, hydrated: true }),
  applyBotUsernameSuffix: (name: string) => name,
  findAgentByOxyHandle: async () => null,
}));
vi.mock('../alia-gemie.js', () => ({ loadAliaGemie: async () => ({ _id: 'alia' }) }));
vi.mock('../oxy.js', () => ({ oxy: {} }));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, agents: child, general: child } };
});

const { resolveTurnGemie } = await import('../chat/turn-inputs.js');

function turn(channelGemieId: string, extra: Record<string, unknown> = {}) {
  return resolveTurnGemie({
    oxyUserId: 'person-1',
    isDirectUserSession: false,
    surfaceApplicationId: null,
    channelGemieId,
    ...extra,
  });
}

beforeEach(() => {
  state.opens = 'reachable';
  state.asked = [];
  state.agents = new Map([
    [
      'own',
      {
        _id: 'own',
        identity: { source: 'oxy', oxyAccountId: 'bot-own' },
        ownerOxyAccountId: 'person-1',
        access: 'private',
        status: 'active',
      },
    ],
    [
      'stranger',
      {
        _id: 'stranger',
        identity: { source: 'oxy', oxyAccountId: 'bot-x' },
        ownerOxyAccountId: 'other',
        access: 'private',
        status: 'active',
      },
    ],
    [
      'public',
      {
        _id: 'public',
        identity: { source: 'oxy', oxyAccountId: 'bot-p' },
        ownerOxyAccountId: 'other',
        access: 'public',
        status: 'active',
      },
    ],
  ]);
});

describe('a connected account’s turn', () => {
  it('is answered by the account’s own gemie, asked of Oxy in no app', async () => {
    expect(await turn('own')).toMatchObject({
      kind: 'agent',
      agent: { _id: 'own', hydrated: true },
    });
    expect(state.asked).toEqual([{ account: 'bot-own', surface: null }]);
  });

  it('takes the binding’s gemie over any requested one', async () => {
    expect(await turn('public', { requestedAgentId: 'own' })).toMatchObject({
      kind: 'agent',
      agent: { _id: 'public' },
    });
  });

  it('refuses somebody else’s private gemie and never falls back to Alia', async () => {
    expect(await turn('stranger')).toEqual({ kind: 'unavailable', reason: 'out_of_reach' });
    expect(await turn('gone')).toEqual({ kind: 'unavailable', reason: 'not_found' });
    expect(state.asked).toEqual([]);
  });

  it('keeps an Oxy that could not answer apart from a refusal', async () => {
    state.opens = 'identity_unavailable';
    expect(await turn('own')).toEqual({ kind: 'identity_unavailable' });
    state.opens = 'out_of_reach';
    expect(await turn('own')).toEqual({ kind: 'unavailable', reason: 'out_of_reach' });
  });
});
