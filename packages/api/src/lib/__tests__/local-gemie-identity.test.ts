/**
 * A gemie with no Oxy account (ADR 0036): an external agent paired from its owner's computer.
 *
 * What is pinned here: its name and colour are read from its row through the same resolver every
 * gemie goes through, without asking Oxy; its owner, and nobody else, may use and change it,
 * without asking Oxy; its name and colour are edited on its row, and it can be neither listed nor
 * shared; and nothing that needs an account of its own (unattended work, connected accounts, an Oxy
 * lane) is open to it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  oxyAsked: 0,
  hydrated: [] as string[][],
  rows: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ id: string; input: Record<string, unknown> }>,
  accountWrites: 0,
}));

const LOCAL = {
  _id: 'local-1',
  id: 'local-1',
  identity: { source: 'local', name: 'Claude Code · desk', color: 'orange' },
  ownerOxyAccountId: 'owner-1',
  author: 'owner-1',
  access: 'private',
  status: 'active',
  isPublished: false,
  reach: 'grants',
  tagline: 'Claude Code on desk',
  character: { shape: 'bot_blob', eyes: 'bot', eyewear: 'none', accessory: 'none' },
};

const OXY = {
  _id: 'oxy-1',
  id: 'oxy-1',
  identity: { source: 'oxy', oxyAccountId: 'bot-1' },
  ownerOxyAccountId: 'owner-1',
  author: 'owner-1',
  access: 'private',
  status: 'active',
  isPublished: true,
  reach: 'grants',
  tagline: 'Finds things',
  character: LOCAL.character,
};

vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: async (_db: unknown, id: string) => state.rows.get(id) ?? null,
  findAgentByOxyAccountId: async () => null,
  findHireableAgentByOxyAccountId: async () => null,
  updateAgent: async (_db: unknown, id: string, input: Record<string, unknown>) => {
    state.updates.push({ id, input });
    return { ...state.rows.get(id), ...input };
  },
  findAgentSkills: async () => [],
  findAgentKnowledge: async () => [],
  withoutInternalAgentBindings: (row: unknown) => row,
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../oxy-user-hydration.js', () => ({
  hydrateOxyUsers: async (ids: readonly string[]) => {
    state.hydrated.push([...ids]);
    return new Map(
      ids
        .filter((id) => id === 'bot-1')
        .map((id) => [id, { displayName: 'Nadia', username: 'nadiabot', color: 'blue' }]),
    );
  },
}));
vi.mock('../oxy.js', () => ({
  oxy: {
    withUser: async (_token: string, run: (client: unknown) => Promise<unknown>) => {
      state.oxyAsked++;
      return run({
        accounts: {
          // Its owner may act as the Oxy gemie's account.
          get: async (accountId: string) => ({
            accountId,
            parentAccountId: 'owner-1',
            kind: 'bot',
            relationship: 'owner',
            account: { id: accountId, kind: 'bot' },
            callerMembership: { status: 'active', role: 'owner', permissions: ['account:act_as'] },
          }),
          update: async () => {
            state.accountWrites++;
          },
        },
      });
    },
    agency: {
      agentAvailability: async () => {
        state.oxyAsked++;
        return { anywhere: true, applicationIds: [] };
      },
    },
    users: { byUsername: async () => ({ id: 'nobody' }) },
  },
}));
vi.mock('../chat-core.js', () => ({ resolveModel: async () => ({}) }));
vi.mock('../logger.js', () => {
  const c = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: c, agents: c, chat: c } };
});

const { attachAgentIdentities } = await import('../agent-identity.js');
const { canReachAgent, loadAgentForActor, loadAgentForAccounts } = await import(
  '../agent-account.js'
);
const { applyAgentEdit } = await import('../agent-update.js');
const { unattendedReach } = await import('../automation-actors.js');
const { gemieOxyAccountId, runtimeGemieAccountId, GemieWithoutOxyAccountError } = await import(
  '../gemie-oxy-actor.js'
);

beforeEach(() => {
  state.oxyAsked = 0;
  state.hydrated = [];
  state.updates = [];
  state.accountWrites = 0;
  state.rows = new Map<string, Record<string, unknown>>([
    [LOCAL._id, LOCAL],
    [OXY._id, OXY],
  ]);
});

describe('its identity is resolved like every gemie’s, from its row', () => {
  it('names a local gemie from its row and asks Oxy only for the accounts in the batch', async () => {
    const [local, oxy] = await attachAgentIdentities([LOCAL, OXY] as never[]);
    expect(local).toMatchObject({ name: 'Claude Code · desk', handle: null, color: 'orange' });
    expect(oxy).toMatchObject({ name: 'Nadia', handle: 'nadiabot', color: 'blue' });
    expect(state.hydrated).toEqual([['bot-1', 'owner-1', 'owner-1']]);
  });
});

describe('only its owner may use or change it, and Oxy is not asked', () => {
  it('opens to its owner', async () => {
    const reach = await canReachAgent(LOCAL as never, {
      oxyUserId: 'owner-1',
      accessToken: 'token',
      surfaceApplicationId: 'some-app',
    });
    expect(reach).toBe('reachable');
    const loaded = await loadAgentForActor({} as never, {
      agentId: LOCAL._id,
      oxyUserId: 'owner-1',
      accessToken: 'token',
      cache: false,
    });
    expect(loaded.ok).toBe(true);
    expect(state.oxyAsked).toBe(0);
  });

  it('is somebody else’s not-found, never a 403', async () => {
    expect(
      await canReachAgent(LOCAL as never, {
        oxyUserId: 'stranger',
        accessToken: 'token',
        surfaceApplicationId: null,
      }),
    ).toBe('out_of_reach');
    expect(
      await loadAgentForActor({} as never, {
        agentId: LOCAL._id,
        oxyUserId: 'stranger',
        accessToken: 'token',
        cache: false,
      }),
    ).toEqual({ ok: false, refusal: 'agent_not_found' });
    expect(state.oxyAsked).toBe(0);
  });

  it('has no connected accounts to manage, even for its owner', async () => {
    expect(
      await loadAgentForAccounts({} as never, {
        agentId: LOCAL._id,
        oxyUserId: 'owner-1',
        accessToken: 'token',
      }),
    ).toEqual({ ok: false, refusal: 'agent_not_found' });
  });
});

describe('its owner edits who it is on its row', () => {
  it('writes the name and the colour to the row, and nothing to Oxy', async () => {
    const outcome = await applyAgentEdit({
      agentId: LOCAL._id,
      userId: 'owner-1',
      accessToken: 'token',
      edit: { tagline: 'Pairs on the desk', character: LOCAL.character as never },
      identity: { name: 'Desk', color: '#ff8b67' },
    });
    expect(outcome.ok).toBe(true);
    expect(state.updates).toEqual([
      {
        id: LOCAL._id,
        input: {
          tagline: 'Pairs on the desk',
          character: LOCAL.character,
          localName: 'Desk',
          localColor: '#ff8b67',
        },
      },
    ]);
    expect(state.accountWrites).toBe(0);
  });

  it.each([{ isPublished: true }, { access: 'public' as const }])(
    'refuses to list or share it (%o)',
    async (edit) => {
      const outcome = await applyAgentEdit({
        agentId: LOCAL._id,
        userId: 'owner-1',
        accessToken: 'token',
        edit,
      });
      expect(outcome).toMatchObject({ ok: false, status: 400 });
      expect(state.updates).toEqual([]);
    },
  );

  it('refuses a colour for an Oxy gemie, whose colour is its account’s', async () => {
    const outcome = await applyAgentEdit({
      agentId: OXY._id,
      userId: 'owner-1',
      accessToken: 'token',
      edit: {},
      identity: { color: 'blue' },
    });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
  });
});

describe('nothing that needs an account of its own is open to it', () => {
  it('does no unattended work', async () => {
    expect(await unattendedReach(LOCAL as never, 'owner-1')).toBe('out_of_reach');
  });

  it('acts as nobody at Oxy, and Alia’s runtime refuses it loudly', () => {
    expect(gemieOxyAccountId(LOCAL as never)).toBeNull();
    expect(gemieOxyAccountId(OXY as never)).toBe('bot-1');
    expect(() => runtimeGemieAccountId(LOCAL as never)).toThrow(GemieWithoutOxyAccountError);
  });
});
