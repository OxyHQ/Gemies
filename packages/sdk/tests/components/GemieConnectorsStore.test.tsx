import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The connectors store both apps draw, over hundreds of entries: the API searches, filters, sorts
 * and pages; the store sends what the person chose and draws each entry's badge. Bloom is stubbed
 * into host elements carrying their props; the hooks and the routes are real, over a stubbed API.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: element('View'), Pressable: element('Pressable'), Platform: { OS: 'ios' } };
});
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(), openAuthSessionAsync: vi.fn() }));
vi.mock('@oxy.so/bloom/typography', async () => host('Text'));
vi.mock('@oxy.so/bloom/button', async () => host('Button'));
vi.mock('@oxy.so/bloom/badge', async () => host('Badge'));
vi.mock('@oxy.so/bloom/chip', async () => ({
  ...(await host('Chip')),
  ...(await host('ChipRow')),
}));
vi.mock('@oxy.so/bloom/search', async () => host('Search'));
vi.mock('@oxy.so/bloom/dialog', async () => ({ Dialog: () => null }));
vi.mock('@oxy.so/bloom/accordion', () => ({
  Accordion: () => null,
  AccordionContent: () => null,
  AccordionItem: () => null,
  AccordionTrigger: () => null,
}));
vi.mock('@oxy.so/bloom/text-field', () => ({
  TextFieldInput: () => null,
  TextFieldLabel: () => null,
}));
vi.mock('@oxy.so/bloom/select', async () => ({
  Select: (await host('Select')).Select,
  SelectContent: () => null,
  SelectIcon: () => null,
  SelectItem: () => null,
  SelectItemText: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock('@oxy.so/bloom/skeleton', async () => ({
  ...(await host('Box')),
  ...(await host('Region')),
}));
for (const icon of [
  'RiAddLine',
  'RiLockUnlockLine',
  'RiShieldCheckFill',
  'RiShieldCheckLine',
  'RiUserCommunityLine',
]) {
  vi.doMock(`@oxy.so/bloom/icons/${icon}`, () => ({ [icon]: () => null }));
}
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('../../src/runtime/api', () => ({ useGemieApi: () => api }));
vi.mock('../../src/components/connectors/ConnectorLogo', () => ({ ConnectorLogo: () => null }));
vi.mock('../../src/runtime/config', () => ({
  useGemieRuntime: () => ({ apiUrl: 'https://api.gemies.ai' }),
}));

async function host(name: string): Promise<Record<string, unknown>> {
  const ReactModule = await import('react');
  return {
    [name]: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children),
  };
}

const { GemieConnectorsStore } = await import(
  '../../src/components/connectors/GemieConnectorsStore'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: TestRenderer.ReactTestRenderer | null = null;

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  description: `${id} server`,
  category: 'data',
  featured: false,
  trust: 'community',
  source: 'mcp_registry',
  signIn: 'oauth',
  toolCount: null,
  docsUrl: null,
  logoUrl: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(
    async (path: string, request?: { params?: Record<string, unknown> }) => {
      if (path === '/mcp/installed') return { data: { servers: [] } };
      if (path !== '/mcp/registry') throw new Error(`unexpected GET ${path}`);
      const offset = Number(request?.params?.offset ?? 0);
      return offset === 0
        ? {
            data: {
              servers: [
                entry('notion', { source: 'curated', trust: 'official', featured: true }),
                entry('weather', { trust: 'verified', signIn: 'none' }),
              ],
              total: 3,
              nextOffset: 2,
              categories: [
                { id: 'data', count: 2 },
                { id: 'finance', count: 1 },
              ],
            },
          }
        : {
            data: {
              servers: [entry('ledger', { category: 'finance' })],
              total: 3,
              nextOffset: null,
              categories: [],
            },
          };
    },
  );
  api.post.mockResolvedValue({ data: { server: { displayName: 'weather' } } });
});

afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <GemieConnectorsStore nativeScheme="gemies" />
      </QueryClientProvider>,
    );
  });
  await settle();
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const all = (tree: TestRenderer.ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);
const childText = (node: ReactTestInstance) => [node.props.children].flat().join('');
const storeCalls = () =>
  api.get.mock.calls
    .filter(([path]) => path === '/mcp/registry')
    .map(([, request]) => request?.params);

describe('the connectors store', () => {
  it('draws each entry with its badge, and says which connect without a sign-in', async () => {
    const tree = await render();
    const badges = all(tree, 'Badge').map((node) => node.props.content);
    expect(badges).toEqual(['Official', 'Verified', 'No sign-in']);
    expect(all(tree, 'Text').map(childText)).toContain('All connectors · 3');
  });

  it('asks the API for what the person chose: a filter, a category, a sort', async () => {
    const tree = await render();
    const chip = (label: string) =>
      all(tree, 'Chip').find((node) => childText(node).startsWith(label));
    await act(async () => chip('Official')?.props.onPress());
    await settle();
    await act(async () => chip('Finance')?.props.onPress());
    await settle();
    await act(async () => all(tree, 'Select')[0]?.props.onValueChange('name'));
    await settle();

    expect(storeCalls().at(-1)).toEqual({
      category: 'finance',
      trust: 'official',
      sort: 'name',
      offset: 0,
      limit: 30,
    });
  });

  it('shows the next page on request', async () => {
    const tree = await render();
    const more = all(tree, 'Button').find((node) => childText(node) === 'Show 1 more');
    await act(async () => more?.props.onPress());
    await settle();
    expect(storeCalls().at(-1)).toMatchObject({ offset: 2 });
    expect(all(tree, 'Text').map(childText)).toContain('ledger');
  });

  it('connects a server that needs no sign-in at once', async () => {
    const tree = await render();
    const connect = all(tree, 'Button').filter((node) => childText(node) === 'Connect')[1];
    await act(async () => connect?.props.onPress());
    await settle();
    expect(api.post).toHaveBeenCalledWith('/mcp/connect', {
      registryId: 'weather',
      returnTo: 'gemies://connectors',
    });
    expect(toast.success).toHaveBeenCalled();
  });
});
