import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The gemie catalogue is public (`GET /agents` is `optionalAuth`): gemies.ai/agents signed out sat
 * on its skeleton forever because the query waited for a signed-in user that never came.
 */

const { get, oxy } = vi.hoisted(() => ({
  get: vi.fn(),
  oxy: { isAuthenticated: false, isPrivateApiPending: false },
}));
vi.mock('@gemies/sdk/runtime', () => ({
  gemieQueryKeys: { agents: { profile: () => ['profile'] } },
}));
vi.mock('@/shared/api/client', () => ({ default: { get } }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => oxy }));

const { useAgentCatalogue } = await import('@/features/agents/runtime/use-agents');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value!: ReturnType<typeof useAgentCatalogue>;
  const Probe = () => {
    value = useAgentCatalogue();
    return null;
  };
  const wrapper = (children: React.ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  act(() => {
    renderer = create(wrapper(<Probe />));
  });
  return () => value;
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  get.mockReset();
  oxy.isAuthenticated = false;
  oxy.isPrivateApiPending = false;
});

describe('useAgentCatalogue', () => {
  it('lists the published gemies for a visitor who is not signed in', async () => {
    get.mockResolvedValue({ data: { agents: [{ _id: 'a1', name: 'Pepe' }], total: 1 } });
    const read = mount();
    await settle();
    expect(get).toHaveBeenCalledWith('/agents', undefined);
    expect(read().data).toEqual({ agents: [{ _id: 'a1', name: 'Pepe' }], total: 1 });
  });

  it('waits while the session is still being resolved', async () => {
    oxy.isAuthenticated = true;
    oxy.isPrivateApiPending = true;
    mount();
    await settle();
    expect(get).not.toHaveBeenCalled();
  });
});
