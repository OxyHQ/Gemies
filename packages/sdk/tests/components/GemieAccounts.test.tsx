import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The connected-accounts panel (ADR 0035), the one both apps draw: the Gemies app in a gemie's
 * editor, the Alia app for Alia's gemie. Bloom is stubbed into host elements carrying their props;
 * the hooks and the routes are real, over a stubbed API.
 */

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => host('Text'));
vi.mock('@oxy.so/bloom/button', async () => host('Button'));
vi.mock('@oxy.so/bloom/switch', async () => host('Switch'));
vi.mock('@oxy.so/bloom/skeleton', async () => ({
  ...(await host('Box')),
  ...(await host('Region')),
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
vi.mock('react-native-qrcode-svg', async () => ({ default: (await host('QRCode')).QRCode }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('../../src/runtime/api', () => ({ useGemieApi: () => api }));

async function host(name: string): Promise<Record<string, unknown>> {
  const ReactModule = await import('react');
  return {
    [name]: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children),
  };
}

import { GemieAccounts } from '../../src/accounts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: TestRenderer.ReactTestRenderer | null = null;
let accounts: Record<string, unknown>[] = [];
let platforms: string[] = [];
let qr: { status: string; qr: string | null } = { status: 'qr-pending', qr: 'QR-2' };
let chats: Record<string, unknown>[] = [];

const account = (over: Record<string, unknown> = {}) => ({
  _id: 'acc-9',
  platform: 'whatsapp',
  phoneNumber: '+34 600',
  displayName: null,
  status: 'connected',
  oxyTaskState: 'active',
  replies: 'everyone',
  replyChatIds: [],
  groupReplies: 'mentions',
  lastActiveAt: null,
  ...over,
});

beforeEach(() => {
  accounts = [];
  platforms = ['whatsapp', 'telegram'];
  qr = { status: 'qr-pending', qr: 'QR-2' };
  chats = [];
  vi.clearAllMocks();
  api.get.mockImplementation(async (path: string) => {
    if (path === '/agents/gemie-1/accounts') return { data: { accounts, platforms } };
    if (path.endsWith('/qr')) return { data: qr };
    if (path.endsWith('/chats')) return { data: { chats } };
    throw new Error(`unexpected GET ${path}`);
  });
  api.post.mockImplementation(async (path: string) =>
    path === '/agents/gemie-1/accounts'
      ? { data: { accountId: 'acc-1', qr: 'QR-1' } }
      : { data: {} },
  );
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  confirm.mockResolvedValue(true);
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
        <GemieAccounts gemieId="gemie-1" name="Scout" />
      </QueryClientProvider>,
    );
  });
  await settle();
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const all = (tree: TestRenderer.ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);
const texts = (tree: TestRenderer.ReactTestRenderer): string[] =>
  all(tree, 'Text').map((node) => [node.props.children].flat().join(''));
const button = (tree: TestRenderer.ReactTestRenderer, label: string) =>
  all(tree, 'Button').find((node) => node.props.accessibilityLabel === label);
const select = (tree: TestRenderer.ReactTestRenderer, value: string) =>
  all(tree, 'Select').find((node) => node.props.value === value);
const switchLabelled = (tree: TestRenderer.ReactTestRenderer, label: string) =>
  all(tree, 'Switch').find((node) => node.props.accessibilityLabel === label);

describe('linking an account', () => {
  it('offers only the platforms this deployment can link, and shows the code to scan', async () => {
    const tree = await render();
    const offered = all(tree, 'Button')
      .map((node) => node.props.accessibilityLabel)
      .filter((label) => String(label).startsWith('Link a'));
    expect(offered).toEqual(['Link a WhatsApp account', 'Link a Telegram account']);

    await act(async () => button(tree, 'Link a WhatsApp account')?.props.onPress());
    await settle();
    expect(api.post).toHaveBeenCalledWith('/agents/gemie-1/accounts', { platform: 'whatsapp' });
    expect(['QR-1', 'QR-2']).toContain(all(tree, 'QRCode')[0]?.props.value);
    expect(texts(tree).some((text) => text.startsWith('Open WhatsApp on your phone'))).toBe(true);
  });

  it('offers no fake control when nothing can be linked here', async () => {
    platforms = [];
    const tree = await render();
    expect(button(tree, 'Link a WhatsApp account')).toBeUndefined();
    expect(texts(tree)).toContain('Linking WhatsApp or Telegram is not available right now.');
  });

  it('says why a link failed, in the panel, and tries again', async () => {
    api.post.mockRejectedValueOnce({
      response: {
        status: 503,
        data: { error: 'Timed out waiting for QR', code: 'accounts_gateway_unavailable' },
      },
    });
    const tree = await render();
    await act(async () => button(tree, 'Link a WhatsApp account')?.props.onPress());
    await settle();
    expect(texts(tree)).toContain('Could not link WhatsApp: Timed out waiting for QR');

    const retry = all(tree, 'Button').find((node) => node.props.children === 'Retry');
    await act(async () => retry?.props.onPress());
    await settle();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(all(tree, 'QRCode')).toHaveLength(1);
    expect(texts(tree).some((text) => text.startsWith('Could not link'))).toBe(false);
  });

  it('closes the code and says so, once, when the account is connected', async () => {
    qr = { status: 'connected', qr: null };
    const tree = await render();
    await act(async () => button(tree, 'Link a Telegram account')?.props.onPress());
    await settle();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Telegram is linked. Scout answers there now.');
    expect(all(tree, 'QRCode')).toHaveLength(0);
  });

  it('says so when the code expired before the scan', async () => {
    qr = { status: 'failed', qr: null };
    const tree = await render();
    await act(async () => button(tree, 'Link a WhatsApp account')?.props.onPress());
    await settle();
    expect(toast.error).toHaveBeenCalledWith(
      'The WhatsApp code expired before it was scanned. Link it again.',
    );
  });

  it('forgets the link when the person cancels it', async () => {
    const tree = await render();
    await act(async () => button(tree, 'Link a WhatsApp account')?.props.onPress());
    await settle();
    const cancel = all(tree, 'Button').find((node) => node.props.children === 'Cancel');
    await act(async () => cancel?.props.onPress());
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/agents/gemie-1/accounts/acc-1');
  });
});

describe('when the API does not answer', () => {
  it('says so with a retry, offers nothing else, and recovers when it answers', async () => {
    const answer = api.get.getMockImplementation();
    api.get.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <GemieAccounts gemieId="gemie-1" name="Scout" />
        </QueryClientProvider>,
      );
    });
    await settle();
    const tree = renderer!;
    expect(texts(tree)).toContain('Could not load this. Try again.');
    expect(button(tree, 'Link a WhatsApp account')).toBeUndefined();

    api.get.mockImplementation(answer!);
    const retry = all(tree, 'Button').find((node) => node.props.children === 'Retry');
    await act(async () => retry?.props.onPress());
    await settle();
    expect(button(tree, 'Link a WhatsApp account')).toBeDefined();
  });
});

describe('a linked account', () => {
  it('shows its live status and last message, and is removed after confirming', async () => {
    accounts = [account({ lastActiveAt: '2026-11-13T09:00:00.000Z' })];
    const tree = await render();
    expect(texts(tree)).toContain('+34 600 · Connected');
    expect(texts(tree).some((text) => text.startsWith('Last message: '))).toBe(true);
    await act(async () => button(tree, 'Remove the WhatsApp account')?.props.onPress());
    await settle();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, title: 'Remove WhatsApp' }),
    );
    expect(api.delete).toHaveBeenCalledWith('/agents/gemie-1/accounts/acc-9');
  });

  it('says how to recover one unlinked from the phone, and offers no settings for it', async () => {
    accounts = [account({ status: 'logged-out' })];
    const tree = await render();
    expect(
      texts(tree).some((text) =>
        text.includes('Unlinked from the phone. Remove it and link it again.'),
      ),
    ).toBe(true);
    expect(all(tree, 'Select')).toHaveLength(0);
  });

  it('saves who it answers and in groups', async () => {
    accounts = [account()];
    const tree = await render();
    await act(async () => select(tree, 'everyone')?.props.onValueChange('nobody'));
    expect(api.patch).toHaveBeenCalledWith('/agents/gemie-1/accounts/acc-9', {
      replies: 'nobody',
    });
    await act(async () => select(tree, 'mentions')?.props.onValueChange('never'));
    expect(api.patch).toHaveBeenCalledWith('/agents/gemie-1/accounts/acc-9', {
      groupReplies: 'never',
    });
  });

  it('chooses the chats it answers from the account’s own', async () => {
    accounts = [account({ replies: 'chosen', replyChatIds: ['ana@s.whatsapp.net'] })];
    chats = [
      { chatId: 'ana@s.whatsapp.net', name: 'Ana', kind: 'direct' },
      { chatId: 'family@g.us', name: 'Family', kind: 'group' },
    ];
    const tree = await render();
    expect(switchLabelled(tree, 'Answer Ana')?.props.checked).toBe(true);
    expect(switchLabelled(tree, 'Answer Family')?.props.checked).toBe(false);
    await act(async () => switchLabelled(tree, 'Answer Family')?.props.onCheckedChange(true));
    expect(api.patch).toHaveBeenCalledWith('/agents/gemie-1/accounts/acc-9', {
      replyChatIds: ['ana@s.whatsapp.net', 'family@g.us'],
    });
  });

  it('renews a lapsed account task without a new link', async () => {
    accounts = [account({ oxyTaskState: 'reauth_required' })];
    await render();
    expect(api.post).toHaveBeenCalledWith('/agents/gemie-1/accounts/acc-9/reauthorize');
  });
});
