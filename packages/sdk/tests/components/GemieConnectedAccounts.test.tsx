import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The connected-accounts screens (ADR 0035 as amended), the ones both apps draw: Settings ›
 * Connected accounts (`GemieConnectedAccounts`), where a person connects each account once, grants
 * it to their gemies and chooses the one that answers it, and a gemie's editor
 * (`GemieAccountGrants`), the same grants seen from one gemie. Bloom is stubbed into host elements
 * carrying their props; the hooks and the routes are real, over a stubbed API.
 */

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => true) }));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
    Linking: linking,
  };
});
vi.mock('@oxy.so/bloom/typography', async () => host('Text'));
vi.mock('@oxy.so/bloom/button', async () => host('Button'));
vi.mock('@oxy.so/bloom/switch', async () => host('Switch'));
vi.mock('@oxy.so/bloom/icons/RiWhatsappFill', async () => host('RiWhatsappFill'));
vi.mock('@oxy.so/bloom/icons/RiTelegramFill', async () => host('RiTelegramFill'));
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

import { GemieAccountGrants, GemieConnectedAccounts } from '../../src/accounts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: TestRenderer.ReactTestRenderer | null = null;
let accounts: Record<string, unknown>[] = [];
let platforms: string[] = [];
let qr: { status: string; qr: string | null } = { status: 'qr-pending', qr: 'QR-2' };
let chats: Record<string, unknown>[] = [];
const GEMIES = [
  { id: 'alia', name: 'Alia' },
  { id: 'scout', name: 'Scout' },
];

const account = (over: Record<string, unknown> = {}) => ({
  _id: 'acc-9',
  platform: 'whatsapp',
  phoneNumber: '+34 600',
  displayName: null,
  status: 'connected',
  oxyTaskState: 'active',
  gemieIds: [],
  answeringGemieId: null,
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
    if (path === '/me/accounts') return { data: { accounts, gemies: GEMIES, platforms } };
    if (path.endsWith('/qr')) return { data: qr };
    if (path.endsWith('/chats')) return { data: { chats } };
    throw new Error(`unexpected GET ${path}`);
  });
  api.post.mockImplementation(async (path: string) =>
    path === '/me/accounts' ? { data: { accountId: 'acc-1', qr: 'QR-1' } } : { data: {} },
  );
  api.patch.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
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

async function render(
  element: React.ReactElement = <GemieConnectedAccounts />,
): Promise<TestRenderer.ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
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

describe('connecting an account, once, in Settings', () => {
  it('offers only the platforms this deployment can connect, and shows the code to scan', async () => {
    const tree = await render();
    const offered = all(tree, 'Button')
      .map((node) => node.props.accessibilityLabel)
      .filter((label) => String(label).startsWith('Connect a'));
    expect(offered).toEqual(['Connect a WhatsApp account', 'Connect a Telegram account']);

    await act(async () => button(tree, 'Connect a WhatsApp account')?.props.onPress());
    await settle();
    expect(api.post).toHaveBeenCalledWith('/me/accounts', { platform: 'whatsapp' });
    expect(['QR-1', 'QR-2']).toContain(all(tree, 'QRCode')[0]?.props.value);
    expect(texts(tree).some((text) => text.startsWith('Open WhatsApp on your phone'))).toBe(true);
  });

  it('offers no fake control when nothing can be connected here', async () => {
    platforms = [];
    const tree = await render();
    expect(button(tree, 'Connect a WhatsApp account')).toBeUndefined();
    expect(texts(tree)).toContain('Connecting WhatsApp or Telegram is not available right now.');
  });

  it('says why a connection failed, in the panel, and tries again', async () => {
    api.post.mockRejectedValueOnce({
      response: {
        status: 503,
        data: { error: 'Timed out waiting for QR', code: 'accounts_gateway_unavailable' },
      },
    });
    const tree = await render();
    await act(async () => button(tree, 'Connect a WhatsApp account')?.props.onPress());
    await settle();
    expect(texts(tree)).toContain('Could not connect WhatsApp: Timed out waiting for QR');

    const retry = all(tree, 'Button').find((node) => node.props.children === 'Retry');
    await act(async () => retry?.props.onPress());
    await settle();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(all(tree, 'QRCode')).toHaveLength(1);
    expect(texts(tree).some((text) => text.startsWith('Could not connect'))).toBe(false);
  });

  it('closes the code and says so, once, when the account is connected', async () => {
    qr = { status: 'connected', qr: null };
    const tree = await render();
    await act(async () => button(tree, 'Connect a Telegram account')?.props.onPress());
    await settle();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      'Telegram is connected. Choose which of your gemies may use it.',
    );
    expect(all(tree, 'QRCode')).toHaveLength(0);
  });

  it('says so when the code expired before the scan', async () => {
    qr = { status: 'failed', qr: null };
    const tree = await render();
    await act(async () => button(tree, 'Connect a WhatsApp account')?.props.onPress());
    await settle();
    expect(toast.error).toHaveBeenCalledWith(
      'The WhatsApp code expired before it was scanned. Connect it again.',
    );
  });

  it('forgets the connection when the person cancels it', async () => {
    const tree = await render();
    await act(async () => button(tree, 'Connect a WhatsApp account')?.props.onPress());
    await settle();
    const cancel = all(tree, 'Button').find((node) => node.props.children === 'Cancel');
    await act(async () => cancel?.props.onPress());
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/me/accounts/acc-1');
  });

  it('says so with a retry when the API does not answer, and recovers when it does', async () => {
    const answer = api.get.getMockImplementation();
    api.get.mockRejectedValue(new TypeError('Failed to fetch'));
    const tree = await render();
    expect(texts(tree)).toContain('Could not load this. Try again.');
    expect(button(tree, 'Connect a WhatsApp account')).toBeUndefined();

    api.get.mockImplementation(answer!);
    const retry = all(tree, 'Button').find((node) => node.props.children === 'Retry');
    await act(async () => retry?.props.onPress());
    await settle();
    expect(button(tree, 'Connect a WhatsApp account')).toBeDefined();
  });
});

describe('a connected account in Settings', () => {
  it('shows which account it is, its live status and last message, and is removed after confirming', async () => {
    accounts = [account({ lastActiveAt: '2026-11-13T09:00:00.000Z' })];
    const tree = await render();
    expect(texts(tree)).toContain('WhatsApp · +34 600');
    expect(texts(tree)).toContain('Connected');
    expect(texts(tree).some((text) => text.startsWith('Last message: '))).toBe(true);
    await act(async () => button(tree, 'Remove the WhatsApp account')?.props.onPress());
    await settle();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, title: 'Remove WhatsApp' }),
    );
    expect(api.delete).toHaveBeenCalledWith('/me/accounts/acc-9');
  });

  it('grants and revokes each of the person’s gemies, Alia among them', async () => {
    accounts = [account({ gemieIds: ['alia'] })];
    const tree = await render();
    expect(switchLabelled(tree, 'Alia may use WhatsApp · +34 600')?.props.checked).toBe(true);
    expect(switchLabelled(tree, 'Scout may use WhatsApp · +34 600')?.props.checked).toBe(false);
    await act(async () =>
      switchLabelled(tree, 'Scout may use WhatsApp · +34 600')?.props.onCheckedChange(true),
    );
    expect(api.put).toHaveBeenCalledWith('/me/accounts/acc-9/gemies/scout');
    await act(async () =>
      switchLabelled(tree, 'Alia may use WhatsApp · +34 600')?.props.onCheckedChange(false),
    );
    expect(api.delete).toHaveBeenCalledWith('/me/accounts/acc-9/gemies/alia');
  });

  it('answers with nobody until the person chooses a gemie, and says what that means', async () => {
    accounts = [account({ gemieIds: ['alia'] })];
    const tree = await render();
    expect(texts(tree).some((text) => text.startsWith('No gemie replies on its own'))).toBe(true);
    // No reply policy for a gemie that does not exist.
    expect(select(tree, 'everyone')).toBeUndefined();
    await act(async () => select(tree, '')?.props.onValueChange('scout'));
    expect(api.patch).toHaveBeenCalledWith('/me/accounts/acc-9', { answeringGemieId: 'scout' });
  });

  it('saves who the answering gemie answers, and in groups, or makes nobody answer', async () => {
    accounts = [account({ gemieIds: ['scout'], answeringGemieId: 'scout' })];
    const tree = await render();
    expect(texts(tree)).toContain('Answers on its own');
    await act(async () => select(tree, 'everyone')?.props.onValueChange('nobody'));
    expect(api.patch).toHaveBeenCalledWith('/me/accounts/acc-9', { replies: 'nobody' });
    await act(async () => select(tree, 'mentions')?.props.onValueChange('never'));
    expect(api.patch).toHaveBeenCalledWith('/me/accounts/acc-9', { groupReplies: 'never' });
    await act(async () => select(tree, 'scout')?.props.onValueChange(''));
    expect(api.patch).toHaveBeenCalledWith('/me/accounts/acc-9', { answeringGemieId: null });
  });

  it('chooses the chats it answers from the account’s own', async () => {
    accounts = [
      account({
        answeringGemieId: 'scout',
        replies: 'chosen',
        replyChatIds: ['ana@s.whatsapp.net'],
      }),
    ];
    chats = [
      { chatId: 'ana@s.whatsapp.net', name: 'Ana', kind: 'direct' },
      { chatId: 'family@g.us', name: 'Family', kind: 'group' },
    ];
    const tree = await render();
    expect(switchLabelled(tree, 'Answer Ana')?.props.checked).toBe(true);
    expect(switchLabelled(tree, 'Answer Family')?.props.checked).toBe(false);
    await act(async () => switchLabelled(tree, 'Answer Family')?.props.onCheckedChange(true));
    expect(api.patch).toHaveBeenCalledWith('/me/accounts/acc-9', {
      replyChatIds: ['ana@s.whatsapp.net', 'family@g.us'],
    });
  });

  it('says how to recover one unlinked from the phone, and offers no settings for it', async () => {
    accounts = [account({ status: 'logged-out' })];
    const tree = await render();
    expect(
      texts(tree).some((text) =>
        text.includes('Unlinked from the phone. Remove it and connect it again.'),
      ),
    ).toBe(true);
    expect(all(tree, 'Select')).toHaveLength(0);
    expect(all(tree, 'Switch')).toHaveLength(0);
  });

  it('renews the answering gemie’s lapsed task without a new link, and only where one answers', async () => {
    accounts = [
      account({ oxyTaskState: 'reauth_required', answeringGemieId: 'scout' }),
      account({ _id: 'acc-10', oxyTaskState: 'reauth_required' }),
    ];
    await render();
    expect(api.post).toHaveBeenCalledWith('/me/accounts/acc-9/reauthorize');
    expect(api.post).not.toHaveBeenCalledWith('/me/accounts/acc-10/reauthorize');
  });
});

describe('Telegram Business (ADR 0037)', () => {
  const LINK = 'https://t.me/gemies_bot?start=abc';

  it('says it needs Premium and covers private chats only, and walks through both steps', async () => {
    api.post.mockImplementation(async () => ({ data: { accountId: 'acc-1', qr: LINK } }));
    qr = { status: 'qr-pending', qr: LINK };
    const tree = await render();
    expect(texts(tree).some((text) => text.includes('needs Telegram Premium'))).toBe(true);

    await act(async () => button(tree, 'Connect a Telegram account')?.props.onPress());
    await settle();
    expect(texts(tree)).toContain('Connect Telegram');
    expect(texts(tree).some((text) => text.includes('Telegram Business › Chatbots'))).toBe(true);
    expect(all(tree, 'QRCode')[0]?.props.value).toBe(LINK);
    const open = all(tree, 'Button').find((node) => node.props.children === 'Open Telegram');
    await act(async () => open?.props.onPress());
    expect(linking.openURL).toHaveBeenCalledWith(LINK);
  });

  it('keeps the steps of a connection the person left, until Telegram connects it', async () => {
    accounts = [account({ platform: 'telegram', status: 'qr-pending', phoneNumber: null })];
    qr = { status: 'qr-pending', qr: null };
    const tree = await render();
    expect(texts(tree).some((text) => text.includes('Telegram knows it is you'))).toBe(true);
  });

  it('shows paused and revoked as Telegram reports them, never as a sign-in', async () => {
    accounts = [
      account({ platform: 'telegram', status: 'paused', displayName: '@ada', phoneNumber: null }),
    ];
    let tree = await render();
    expect(texts(tree)).toContain('Telegram · @ada');
    expect(texts(tree)).toContain(
      'Paused in Telegram. It resumes on its own when you turn the bot back on there.',
    );
    act(() => renderer?.unmount());
    renderer = null;

    accounts = [
      account({
        platform: 'telegram',
        status: 'logged-out',
        displayName: '@ada',
        phoneNumber: null,
      }),
    ];
    tree = await render();
    expect(texts(tree).some((text) => text.includes('Revoked: this Telegram was connected'))).toBe(
      true,
    );
    expect(texts(tree).some((text) => /sign in|log in/i.test(text))).toBe(false);
  });

  it('says when Telegram does not let the answering gemie reply, and offers no group setting', async () => {
    accounts = [
      account({
        platform: 'telegram',
        canReply: false,
        displayName: '@ada',
        phoneNumber: null,
        answeringGemieId: 'scout',
      }),
    ];
    const tree = await render();
    expect(texts(tree).some((text) => text.includes('does not let Scout reply'))).toBe(true);
    expect(select(tree, 'mentions')).toBeUndefined();
    expect(select(tree, 'everyone')).toBeDefined();
  });
});

describe('the accounts a gemie can use, in its editor', () => {
  const manage = vi.fn();
  const grants = () =>
    render(<GemieAccountGrants gemieId="scout" name="Scout" onManage={manage} />);

  it('lists the person’s connected accounts, one switch each, and grants or revokes this gemie', async () => {
    accounts = [
      account({ gemieIds: ['scout'], answeringGemieId: 'scout' }),
      account({ _id: 'acc-10', platform: 'telegram', phoneNumber: null, displayName: '@ada' }),
      // Not connected yet: Settings' to finish, never a switch here.
      account({ _id: 'acc-11', status: 'qr-pending' }),
    ];
    const tree = await grants();
    expect(all(tree, 'Switch').map((node) => node.props.accessibilityLabel)).toEqual([
      'Scout may use WhatsApp · +34 600',
      'Scout may use Telegram · @ada',
    ]);
    expect(switchLabelled(tree, 'Scout may use WhatsApp · +34 600')?.props.checked).toBe(true);
    // Which account it answers on its own is said, not hidden.
    expect(texts(tree)).toContain('Answers on its own');

    await act(async () =>
      switchLabelled(tree, 'Scout may use Telegram · @ada')?.props.onCheckedChange(true),
    );
    expect(api.put).toHaveBeenCalledWith('/me/accounts/acc-10/gemies/scout');
    await act(async () =>
      switchLabelled(tree, 'Scout may use WhatsApp · +34 600')?.props.onCheckedChange(false),
    );
    expect(api.delete).toHaveBeenCalledWith('/me/accounts/acc-9/gemies/scout');
  });

  it('sends the person to Settings to connect one, and says when there is none', async () => {
    const tree = await grants();
    expect(texts(tree)).toContain('You have not connected a WhatsApp or Telegram account yet.');
    const open = all(tree, 'Button').find(
      (node) => node.props.children === 'Connect or manage accounts',
    );
    await act(async () => open?.props.onPress());
    expect(manage).toHaveBeenCalledOnce();
  });
});
