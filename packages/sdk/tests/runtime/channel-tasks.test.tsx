import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A person's channels' Oxy tasks (`src/runtime/channel-tasks.ts`): renewed silently once a session
 * for the signed-in account, never signed out, and on the one tap a channel's notice opens. A
 * renewed connected account re-reads the accounts list.
 */

const wire = vi.hoisted(() => ({
  calls: [] as string[],
  signedIn: true,
  renewal: { renewed: [] as unknown[], failed: [] as unknown[] },
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    isAuthenticated: wire.signedIn,
    user: wire.signedIn ? { id: 'person-1' } : null,
  }),
}));
vi.mock('../../src/runtime/api', () => {
  const api = {
    post: async (path: string) => {
      wire.calls.push(path);
      return { status: 200, data: wire.renewal };
    },
  };
  return { useGemieApi: () => api };
});

import { gemieQueryKeys } from '../../src/runtime/query-keys';
import {
  type ChannelTaskRenewal,
  useChannelTaskRenewal,
  useReauthorizeChannels,
} from '../../src/runtime/channel-tasks';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let client: QueryClient;
let renderer: ReactTestRenderer | undefined;
let reauthorize: ReturnType<typeof useReauthorizeChannels>;

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function Handshake() {
  useChannelTaskRenewal();
  return null;
}

function OneTap() {
  reauthorize = useReauthorizeChannels();
  return null;
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  await tick();
}

beforeEach(() => {
  wire.calls = [];
  wire.signedIn = true;
  wire.renewal = { renewed: [], failed: [] };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  client.clear();
});

describe('the silent handshake', () => {
  it('renews once a session, however often the app renders', async () => {
    await mount(<Handshake />);
    await act(async () => {
      renderer?.update(
        <QueryClientProvider client={client}>
          <Handshake />
        </QueryClientProvider>,
      );
    });
    await tick();
    expect(wire.calls).toEqual(['/me/channel-tasks/renew']);
  });

  it('asks nothing signed out', async () => {
    wire.signedIn = false;
    await mount(<Handshake />);
    expect(wire.calls).toEqual([]);
  });

  it('re-reads the accounts list when it renewed one', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    wire.renewal = { renewed: [{ kind: 'account', id: 'acc-1' }], failed: [] };
    await mount(<Handshake />);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: gemieQueryKeys.accounts.all });
  });
});

describe('the one tap', () => {
  it('renews every channel that needs it, and says what it could not', async () => {
    wire.renewal = {
      renewed: [{ kind: 'gemie_bot', id: 'bot-1' }],
      failed: [{ kind: 'bot_link', id: 'link-1' }],
    };
    await mount(<OneTap />);
    let answer: ChannelTaskRenewal | undefined;
    await act(async () => {
      answer = await reauthorize.mutateAsync();
    });
    expect(wire.calls).toEqual(['/me/channel-tasks/renew']);
    expect(answer?.failed).toEqual([{ kind: 'bot_link', id: 'link-1' }]);
  });
});
