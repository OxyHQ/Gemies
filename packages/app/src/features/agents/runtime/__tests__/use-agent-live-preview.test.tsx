import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * An edit of how an agent looks reaches everything that draws it as it is made, before the save:
 * the person's list and the chat's profile in the account's store, the detail in its query.
 */

vi.mock('@/shared/api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('@gemies/sdk/runtime', async () => {
  const data = await import('@/shared/testing/sdk-runtime-data');
  // The SDK's `agentProfile`: an answer per agent id, whose key ignores the client.
  const agentProfile = data.answerSource('test.agent-profile', {
    key: (_api: unknown, agentId: string) => agentId,
    load: async () => null,
  });
  return { ...data, agentProfile, useGemieApi: () => ({}) };
});

import { useAgentLivePreview } from '@/features/agents/runtime/use-agent-live-preview';
import { myAgents } from '@/shared/api/account-data';
import { queryKeys } from '@/shared/api/query-keys';
import { ACCOUNT, agentProfile } from '@gemies/sdk/runtime';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const blue = { preset: 'blue_beret' } as never;
const green = { preset: 'lime_frog' } as never;

function setup({ held = true }: { held?: boolean } = {}) {
  const client = new QueryClient();
  const store = new Store();
  if (held) {
    withStore(store, () => {
      myAgents.entity.put({
        id: ACCOUNT,
        value: [
          { _id: 'a1', name: 'Pepe', tagline: 'hi', character: blue },
          { _id: 'a2', name: 'Ana', tagline: 'yo', character: blue },
        ] as never,
      });
      agentProfile.entity.put({
        id: 'a1',
        value: { id: 'a1', name: 'Pepe', character: blue } as never,
      });
    });
    client.setQueryData(queryKeys.agents.detail('a1'), {
      _id: 'a1',
      name: 'Pepe',
      tagline: 'hi',
      character: blue,
    });
  }
  let preview!: ReturnType<typeof useAgentLivePreview>;
  const Probe = () => {
    preview = useAgentLivePreview('a1');
    return null;
  };
  act(() => {
    create(
      <DataProvider store={store}>
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      </DataProvider>,
    );
  });
  const mine = () =>
    withStore(store, () => myAgents.entity.get(ACCOUNT))?.value as
      | Array<{ _id: string; character: unknown }>
      | undefined;
  const profile = () => withStore(store, () => agentProfile.entity.get('a1'))?.value;
  return { client, preview, mine, profile };
}

describe('showing an agent’s look ahead of its save', () => {
  it('writes the new avatar into the sidebar’s list, the detail and the chat header’s profile', () => {
    const { client, preview, mine, profile } = setup();
    act(() => preview.show({ character: green }));
    expect(mine()?.find((agent) => agent._id === 'a1')?.character).toEqual(green);
    // Another agent is left alone.
    expect(mine()?.find((agent) => agent._id === 'a2')?.character).toEqual(blue);
    expect(
      client.getQueryData<{ character: unknown }>(queryKeys.agents.detail('a1'))?.character,
    ).toEqual(green);
    expect((profile() as { character: unknown }).character).toEqual(green);
  });

  it('changes only what the edit names, and a tagline is not on the profile', () => {
    const { client, preview, profile } = setup();
    act(() => preview.show({ tagline: 'new line' }));
    expect(client.getQueryData<{ tagline: string }>(queryKeys.agents.detail('a1'))?.tagline).toBe(
      'new line',
    );
    expect(profile()).toEqual({ id: 'a1', name: 'Pepe', character: blue });
  });

  it('writes nothing for an agent nobody has loaded', () => {
    const { client, preview, mine, profile } = setup({ held: false });
    act(() => preview.show({ name: 'X' }));
    expect(mine()).toBeUndefined();
    expect(profile()).toBeUndefined();
    expect(client.getQueryData(queryKeys.agents.detail('a1'))).toBeUndefined();
  });

  it('reads the three again when the save did not land', () => {
    const { client, preview } = setup();
    const list = vi.spyOn(myAgents, 'invalidateAll');
    const lead = vi.spyOn(agentProfile, 'invalidate');
    act(() => preview.show({ name: 'Draft' }));
    act(() => preview.revert());
    expect(list).toHaveBeenCalled();
    expect(lead).toHaveBeenCalledWith(expect.anything(), 'a1');
    expect(client.getQueryState(queryKeys.agents.detail('a1'))?.isInvalidated).toBe(true);
  });
});
