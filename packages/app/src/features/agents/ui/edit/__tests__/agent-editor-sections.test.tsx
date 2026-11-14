import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/shared/i18n/locales/en.json';

/**
 * What an agent has beyond who it is, as the editor draws it: how it works on its own, what it
 * hears about, its inbox and what it remembers (ADR 0026). They are per agent, so they are the
 * agent editor's, not the settings'. Bloom is stubbed at its boundary as host elements carrying
 * their props; the words come from the real catalog; the hooks and the API routes are real.
 */

const { hosts } = vi.hoisted(() => ({
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(
      names.map((name) => [
        name,
        ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
          ReactModule.createElement(name, props, children as React.ReactNode),
      ]),
    );
  },
}));

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());
const mine = vi.hoisted(() => ({ agents: undefined as unknown, pending: false }));
const connections = vi.hoisted(() => ({ list: [] as unknown[] }));
const updateAgent = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/agent-creator', async () =>
  hosts('AgentCreatorField', 'AgentCreatorSection'),
);
vi.mock('@oxy.so/bloom/typography', async () => hosts('Text'));
vi.mock('@/features/agents/ui/edit/sections/editor-select', async () => hosts('EditorSelect'));
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/button-group', async () => hosts('ButtonGroup', 'ButtonGroupItem'));
vi.mock('@oxy.so/bloom/textarea', async () => hosts('Textarea'));
vi.mock('@oxy.so/bloom/skeleton', async () => hosts('Box', 'Region'));
vi.mock('@oxy.so/bloom/settings-modal', async () => hosts('SettingsCard'));
vi.mock('@oxy.so/bloom/icons/RiDeleteBinLine', () => ({ RiDeleteBinLine: 'RiDeleteBinLine' }));
vi.mock('@oxy.so/bloom/icons/RiExternalLinkLine', () => ({
  RiExternalLinkLine: 'RiExternalLinkLine',
}));
vi.mock('@oxy.so/bloom/icons/RiGroupLine', () => ({ RiGroupLine: 'RiGroupLine' }));
vi.mock('@oxy.so/bloom/icons/RiRefreshLine', () => ({ RiRefreshLine: 'RiRefreshLine' }));
vi.mock('@oxy.so/bloom/icons/RiTelegramFill', () => ({ RiTelegramFill: 'RiTelegramFill' }));
vi.mock('@oxy.so/bloom/admonition', async () => hosts('Admonition'));
vi.mock('@oxy.so/bloom/badge', async () => hosts('Badge'));
const reauthorize = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})), isPending: false }));
vi.mock('@gemies/sdk/accounts', async () => ({
  ...(await hosts('GemieAccountGrants')),
  useReauthorizeChannels: () => reauthorize,
}));
const settings = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/features/settings/ui/settings-context', () => ({ useAliaSettings: () => settings }));
vi.mock('@gemies/sdk', async () => ({ readAgentCharacter: (character: unknown) => character }));
vi.mock('@oxy.so/bloom/agent-avatar', async () => hosts('AgentAvatar'));
vi.mock('@oxy.so/bloom/text-field', async () => hosts('TextFieldInput'));
vi.mock('@gemies/sdk/connectors', async () => ({
  ...(await hosts('ConnectorLogo')),
  // The SDK's grant row, reduced to what it draws: what it grants, its name and its switch.
  GrantSwitchRow: await (async () => {
    const ReactModule = await import('react');
    return ({
      leading,
      label,
      detail: _detail,
      first: _first,
      ...props
    }: Record<string, unknown> & { leading?: React.ReactNode; label: string }) =>
      ReactModule.createElement(
        'View',
        null,
        leading,
        ReactModule.createElement('Text', null, label),
        ReactModule.createElement('Switch', props),
      );
  })(),
  connectorQueryKeys: { connected: ['gemie-connectors', 'connected'] },
  useConnections: () => ({ data: connections.list, isPending: false }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, user: { id: 'A' }, activeSessionId: 'session-A' }),
}));
vi.mock('@/shared/api/client', () => ({
  default: api,
  getApiSessionSnapshot: () => JSON.stringify({ userId: 'A', bindingRevision: 1, sessionEpoch: 0 }),
  isCurrentApiSession: () => true,
  onApiSessionContextChange: () => () => {},
}));
vi.mock('@/features/agents/runtime/use-my-agents', () => ({
  useMyAgents: () => ({ data: mine.agents, isPending: mine.pending }),
}));
vi.mock('@/features/agents/runtime/use-agents', () => ({
  useUpdateAgent: () => ({ mutateAsync: updateAgent, isPending: false }),
}));

const { commitAccountProjection } = await import('@/shared/state/account-epoch');
const { AgentEditorSections } = await import(
  '@/features/agents/ui/edit/sections/agent-editor-sections'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render({ hasAccount = true } = {}): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AgentEditorSections
          agentId="agent-1"
          name="Scout"
          look={{ character: { preset: 'blue_beret' }, color: null }}
          hasAccount={hasAccount}
        />
      </QueryClientProvider>,
    );
  });
  await settle();
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const all = (tree: ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);

/** The frequency select: the editor also has a computer select, so never index by position. */
const select = (tree: ReactTestRenderer, label: string) =>
  all(tree, 'EditorSelect').find((node) => String(node.props.label).startsWith(label));

const switchLabelled = (tree: ReactTestRenderer, label: string) =>
  all(tree, 'Switch').find((node) => String(node.props.accessibilityLabel).includes(label));

/** Every string the editor's rows and notes draw. */
const texts = (tree: ReactTestRenderer): string[] =>
  all(tree, 'Text').map((node) => [node.props.children].flat().join(''));

const OWNER = 'owner-account';
const subscription = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  agentId: 'agent-1',
  ownerAccountId: OWNER,
  sourceAccountId: OWNER,
  appId: 'inbox',
  eventType: 'new_email',
  enabled: true,
  ...over,
});

let subscriptions: ReturnType<typeof subscription>[] = [];
let items: unknown[] = [];
let lastHeartbeatAt: string | null = null;
let alerts = {
  alia: { enabled: true },
  agents: [{ agentId: 'agent-1', name: 'Scout', handle: 'scout', color: null, enabled: false }],
};
let documents: { path: string }[] = [];
/** What the agent's file holds now, as `GET /agents/:id/memory?path=` answers. */
let memoryFile = { content: '- likes tea\n', hash: 'h1' };
let telegramBot: { bot: unknown; available: boolean } = { bot: null, available: true };

beforeEach(() => {
  commitAccountProjection('A', 'session-A');
  connections.list = [];
  subscriptions = [];
  items = [];
  lastHeartbeatAt = null;
  documents = [];
  memoryFile = { content: '- likes tea\n', hash: 'h1' };

  alerts = {
    alia: { enabled: true },
    agents: [{ agentId: 'agent-1', name: 'Scout', handle: 'scout', color: null, enabled: false }],
  };
  api.get
    .mockReset()
    .mockImplementation(async (url: string, config?: { params?: { path?: string } }) => {
      if (url === '/notifications/email-alerts') return { data: alerts };
      if (url.endsWith('/telegram-bot')) return { data: telegramBot };
      if (url.endsWith('/inbox'))
        return { data: { items, heartbeat: { intervalMinutes: 60, lastHeartbeatAt } } };
      if (url.endsWith('/subscriptions')) return { data: { subscriptions } };
      if (url.endsWith('/memory'))
        return config?.params?.path
          ? {
              data: { path: config.params.path, ...memoryFile, exists: true },
            }
          : {
              data: {
                documents: documents.map((d) => ({
                  ...d,
                  byteLength: 12,
                  updatedAt: '2026-10-06T00:00:00.000Z',
                })),
              },
            };
      throw new Error(`unexpected GET ${url}`);
    });
  api.put.mockReset().mockResolvedValue({ data: {} });
  api.post.mockReset().mockResolvedValue({ data: { subscription: subscription() } });
  api.delete.mockReset().mockResolvedValue({ data: undefined });
  toast.error.mockReset();
  confirm.mockReset().mockResolvedValue(true);
  updateAgent.mockReset().mockResolvedValue({});
  mine.pending = false;
  mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: null }];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('whose computer the agent works on', () => {
  it('shows the default as Alia’s and changes it to the agent’s own', async () => {
    const tree = await render();
    const computer = select(tree, 'Where Scout works');
    expect(computer?.props.value).toBe('alia');
    expect(computer?.props.items.map((item: { value: string }) => item.value)).toEqual([
      'alia',
      'own',
    ]);
    await act(async () => computer?.props.onChange('own'));
    expect(updateAgent).toHaveBeenCalledWith({ id: 'agent-1', updates: { computerSource: 'own' } });
  });

  it('shows an agent that keeps its own machine as such, and moves it back', async () => {
    mine.agents = [
      {
        _id: 'agent-1',
        name: 'Scout',
        handle: 'scout',
        scheduleInterval: null,
        computerSource: 'own',
      },
    ];
    const tree = await render();
    const computer = select(tree, 'Where Scout works');
    expect(computer?.props.value).toBe('own');
    await act(async () => computer?.props.onChange('alia'));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { computerSource: 'alia' },
    });
  });

  it('explains what the shared computer is, and tells the person when the change fails', async () => {
    updateAgent.mockRejectedValueOnce(new Error('offline'));
    const tree = await render();
    expect(texts(tree).some((text) => text.startsWith("Alia's is the shared workspace"))).toBe(
      true,
    );
    await act(async () => select(tree, 'Where Scout works')?.props.onChange('own'));
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('the connected accounts it may use', () => {
  const notion = (id: string, accountLabel: string) => ({
    _id: id,
    displayName: 'Notion',
    accountLabel,
    status: 'running',
    logoUrl: '/mcp/logos/abc',
  });

  it('grants one account at a time, so two of one connector stay apart', async () => {
    connections.list = [notion('n1', 'ana@acme.com'), notion('n2', 'Home')];
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', capabilityGrants: ['web'] }];
    const tree = await render();

    expect(texts(tree)).toEqual(expect.arrayContaining(['Notion · ana@acme.com', 'Notion · Home']));
    expect(all(tree, 'ConnectorLogo').map((node) => node.props.logoUrl)).toEqual([
      '/mcp/logos/abc',
      '/mcp/logos/abc',
    ]);
    const switches = all(tree, 'Switch').filter((node) =>
      String(node.props.accessibilityLabel).includes('Notion'),
    );
    await act(async () => switches[1]?.props.onCheckedChange(true));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { capabilityGrants: ['web', 'mcp:n2'] },
    });
  });

  it('gives an external agent its connected accounts, and none of the runtime’s cards', async () => {
    connections.list = [notion('n1', 'ana@acme.com')];
    mine.agents = [{ _id: 'agent-1', name: 'Claude Code · desk', capabilityGrants: [] }];
    const tree = await render({ hasAccount: false });
    const sections = all(tree, 'AgentCreatorSection');
    expect(sections).toHaveLength(1);
    const grant = all(tree, 'Switch').find((node) =>
      String(node.props.accessibilityLabel).includes('Notion'),
    );
    await act(async () => grant?.props.onCheckedChange(true));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { capabilityGrants: ['mcp:n1'] },
    });
  });

  it('takes an account away without touching its other grants', async () => {
    connections.list = [notion('n1', 'ana@acme.com')];
    mine.agents = [
      { _id: 'agent-1', name: 'Scout', handle: 'scout', capabilityGrants: ['web', 'mcp:n1'] },
    ];
    const tree = await render();
    const granted = all(tree, 'Switch').find((node) =>
      String(node.props.accessibilityLabel).includes('Notion'),
    );
    expect(granted?.props.checked).toBe(true);
    await act(async () => granted?.props.onCheckedChange(false));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { capabilityGrants: ['web'] },
    });
  });
});

describe('the heartbeat', () => {
  it('is off with no frequency row when the agent has no interval; turning it on starts at an hour', async () => {
    const tree = await render();
    expect(select(tree, 'The longest')).toBeUndefined();
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(true));
    expect(updateAgent).toHaveBeenCalledWith({ id: 'agent-1', updates: { scheduleInterval: 60 } });
  });

  it('turning it off sends null', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 240 }];
    const tree = await render();
    const frequency = select(tree, 'The longest');
    expect(frequency?.props.value).toBe('240');
    expect(frequency?.props.items.map((item: { value: string }) => item.value)).toEqual([
      '15',
      '30',
      '60',
      '240',
      '1440',
    ]);
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(false));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { scheduleInterval: null },
    });
  });

  it('picking a frequency sends its minutes', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 60 }];
    const tree = await render();
    await act(async () => select(tree, 'The longest')?.props.onChange('1440'));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { scheduleInterval: 1440 },
    });
  });

  it('keeps an interval set elsewhere visible as a choice', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 5 }];
    const tree = await render();
    expect(select(tree, 'The longest')?.props.items[0].value).toBe('5');
  });

  it('tells the person when the save fails', async () => {
    updateAgent.mockRejectedValue(new Error('boom'));
    const tree = await render();
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('what it hears about', () => {
  it('shows both ready-made toggles off and subscribes to the owner account', async () => {
    const tree = await render();
    expect(switchLabelled(tree, 'in your Inbox')?.props.checked).toBe(false);
    await act(async () => switchLabelled(tree, 'in your Inbox')?.props.onCheckedChange(true));
    expect(api.post).toHaveBeenCalledWith('/agents/agent-1/subscriptions', {
      appId: 'inbox',
      eventType: 'new_email',
      account: 'owner',
    });
  });

  it("subscribes to the agent's own mailbox with the second toggle", async () => {
    const tree = await render();
    await act(async () =>
      switchLabelled(tree, 'new emails in its own')?.props.onCheckedChange(true),
    );
    expect(api.post).toHaveBeenCalledWith('/agents/agent-1/subscriptions', {
      appId: 'inbox',
      eventType: 'new_email',
      account: 'agent',
    });
  });

  it('reads each toggle from the subscription, and turning one off deletes it', async () => {
    subscriptions = [
      subscription({ id: 'mine' }),
      subscription({ id: 'its', sourceAccountId: 'bot' }),
    ];
    const tree = await render();
    expect(switchLabelled(tree, 'in your Inbox')?.props.checked).toBe(true);
    expect(switchLabelled(tree, 'new emails in its own')?.props.checked).toBe(true);
    await act(async () =>
      switchLabelled(tree, 'new emails in its own')?.props.onCheckedChange(false),
    );
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/subscriptions/its');
    expect(api.delete).not.toHaveBeenCalledWith('/agents/agent-1/subscriptions/mine');
  });

  it('lists the others with a remove button', async () => {
    subscriptions = [
      subscription({ id: 'api-made', appId: 'calendar', eventType: 'event_created' }),
    ];
    const tree = await render();
    expect(all(tree, 'AgentCreatorField').some((row) => row.props.label === 'calendar')).toBe(true);
    await act(async () =>
      all(tree, 'Button')
        .find((b) => b.props.tone === 'danger')
        ?.props.onPress(),
    );
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/subscriptions/api-made');
  });

  it('says the limit was reached on a 409', async () => {
    api.post.mockRejectedValue({ response: { status: 409, data: { error: 'limit' } } });
    const tree = await render();
    await act(async () => switchLabelled(tree, 'in your Inbox')?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('25'));
  });

  it('lets the agent tell the person about important mail in its own mailbox, and saves a flip', async () => {
    const tree = await render();
    const important = switchLabelled(tree, 'important emails');
    expect(important?.props.checked).toBe(false);
    await act(async () => important?.props.onCheckedChange(true));
    await settle();
    expect(api.put).toHaveBeenCalledWith(
      '/notifications/email-alerts',
      { agentId: 'agent-1', enabled: true },
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe('the inbox', () => {
  it('asks for pending items and renders each as one plain line', async () => {
    items = [
      {
        id: 'i1',
        appId: 'inbox',
        eventType: 'new_email',
        summary: { subject: 'Hola', from: 'ana@x.com' },
      },
      { id: 'i2', appId: 'inbox', eventType: 'new_email', summary: 42 },
    ];
    const tree = await render();
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/inbox', {
      params: { status: 'pending' },
    });
    expect(texts(tree)).toContain('Hola · ana@x.com');
    expect(texts(tree)).toContain('inbox · new_email');
  });

  it('says so when nothing is waiting', async () => {
    const tree = await render();
    expect(texts(tree).some((text) => text.includes('Nothing is waiting'))).toBe(true);
  });

  it('says when the agent last looked, so an empty inbox does not read as broken', async () => {
    lastHeartbeatAt = '2026-11-09T12:00:00.000Z';
    const tree = await render();
    expect(texts(tree).some((text) => text.startsWith('Last looked at its inbox: '))).toBe(true);
    expect(texts(tree).some((text) => text.includes('Nothing is waiting'))).toBe(true);
  });

  it('says so when it has never looked', async () => {
    const tree = await render();
    expect(texts(tree)).toContain("Scout hasn't looked at its inbox yet.");
  });
});

describe('what the agent remembers', () => {
  it('says so when it remembers nothing', async () => {
    const tree = await render();
    expect(texts(tree)).toContain('Scout does not remember anything about you.');
  });

  it('edits a file with the hash it read, and forgets it after confirming', async () => {
    documents = [{ path: 'MEMORY.md' }];
    const tree = await render();

    const textarea = all(tree, 'Textarea')[0]!;
    expect(textarea.props.value).toBe('- likes tea\n');
    await act(async () => textarea.props.onChangeText('- likes coffee\n'));
    const [save] = all(tree, 'ButtonGroupItem');
    await act(async () => save?.props.onPress());
    await settle();
    expect(api.put).toHaveBeenCalledWith('/agents/agent-1/memory', {
      path: 'MEMORY.md',
      content: '- likes coffee\n',
      expectedHash: 'h1',
    });

    const forget = all(tree, 'ButtonGroupItem')[1]!;
    expect(forget.props.accessibilityLabel).toBe('Forget MEMORY.md');
    await act(async () => forget.props.onPress());
    await settle();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, title: 'Forget MEMORY.md' }),
    );
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/memory', {
      params: { path: 'MEMORY.md' },
    });
  });

  it('keeps the edit through a conflicting save, shows the newest version, and saves over it', async () => {
    documents = [{ path: 'MEMORY.md' }];
    const tree = await render();
    const button = (label: string) =>
      all(tree, 'ButtonGroupItem').find((node) => node.props.children === label);

    await act(async () => all(tree, 'Textarea')[0]?.props.onChangeText('- likes coffee\n'));
    // The agent wrote to the file meanwhile: the save names the old hash and loses.
    memoryFile = { content: '- likes tea\n- lives in Madrid\n', hash: 'h2' };
    api.put.mockRejectedValueOnce({ response: { status: 409 } });
    await act(async () => button(en.settings.saveButton)?.props.onPress());
    await settle();

    expect(api.put).toHaveBeenLastCalledWith('/agents/agent-1/memory', {
      path: 'MEMORY.md',
      content: '- likes coffee\n',
      expectedHash: 'h1',
    });
    expect(all(tree, 'Textarea')[0]?.props.value).toBe('- likes coffee\n');
    const notice = String(all(tree, 'Admonition')[0]?.props.children);
    expect(notice).toContain('This note changed while you were editing it.');
    expect(notice).toContain('- lives in Madrid');
    expect(toast.error).not.toHaveBeenCalled();

    // Saving again lands on top of the version the person was shown.
    api.put.mockImplementationOnce(async () => {
      memoryFile = { content: '- likes coffee\n', hash: 'h3' };
      return { data: {} };
    });
    await act(async () => button('Save mine over it')?.props.onPress());
    await settle();
    expect(api.put).toHaveBeenLastCalledWith('/agents/agent-1/memory', {
      path: 'MEMORY.md',
      content: '- likes coffee\n',
      expectedHash: 'h2',
    });
    expect(all(tree, 'Admonition')).toHaveLength(0);
    expect(all(tree, 'Textarea')[0]?.props.value).toBe('- likes coffee\n');
    expect(button(en.settings.saveButton)?.props.disabled).toBe(true);
  });

  it('discards the edit for the newest version only when the person asks', async () => {
    documents = [{ path: 'MEMORY.md' }];
    const tree = await render();
    const button = (label: string) =>
      all(tree, 'ButtonGroupItem').find((node) => node.props.children === label);

    await act(async () => all(tree, 'Textarea')[0]?.props.onChangeText('- likes coffee\n'));
    memoryFile = { content: '- likes tea\n- lives in Madrid\n', hash: 'h2' };
    api.put.mockRejectedValueOnce({ response: { status: 409 } });
    await act(async () => button(en.settings.saveButton)?.props.onPress());
    await settle();
    expect(all(tree, 'Textarea')[0]?.props.value).toBe('- likes coffee\n');

    await act(async () => button('Discard mine')?.props.onPress());
    expect(all(tree, 'Textarea')[0]?.props.value).toBe('- likes tea\n- lives in Madrid\n');
    expect(all(tree, 'Admonition')).toHaveLength(0);
    expect(button('Discard mine')).toBeUndefined();
  });

  it('forgets everything only after the person confirms', async () => {
    documents = [{ path: 'MEMORY.md' }];
    const tree = await render();
    const forgetAll = all(tree, 'Button').find(
      (node) =>
        node.props.tone === 'danger' && String(node.props.children).includes('forget everything'),
    )!;

    confirm.mockResolvedValueOnce(false);
    await act(async () => forgetAll.props.onPress());
    await settle();
    expect(api.delete).not.toHaveBeenCalled();

    await act(async () => forgetAll.props.onPress());
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/memory', { params: {} });
  });
});

describe('the WhatsApp and Telegram accounts it may use', () => {
  it('draws the SDK’s grant list for this gemie, in the editor’s words, and opens Settings to connect more', async () => {
    const tree = await render();
    const list = all(tree, 'GemieAccountGrants')[0];
    expect(list?.props).toMatchObject({ gemieId: 'agent-1', name: 'Scout' });
    expect(list?.props.t('gemie.accounts.grants.manage')).toBe('Connect or manage accounts');
    expect(
      all(tree, 'AgentCreatorSection').some(
        (node) => node.props.title === 'Accounts Scout can use',
      ),
    ).toBe(true);
    await act(async () => list?.props.onManage());
    expect(settings.open).toHaveBeenCalledWith('accounts');
  });
});

describe('its own Telegram bot (ADR 0037)', () => {
  const TOKEN = `8000000002:${'B'.repeat(35)}`;
  const bot = {
    botId: '8000000002',
    username: 'scout_bot',
    name: 'Scout',
    status: 'active',
    groupReplies: 'mentions',
    ownerPaysAgentTurns: true,
    callerPays: true,
    totalMessages: 3,
    lastMessageAt: null,
    profileSyncError: null as string | null,
    personLinked: false,
    personAuthorityLapsed: false,
    linkedAs: null as string | null,
    live: {
      username: 'scout_bot',
      name: 'Scout',
      canJoinGroups: true,
      canReadAllGroupMessages: false,
      webhook: 'ok',
      webhookError: null,
      pendingUpdates: 0,
    },
  };
  const button = (tree: ReactTestRenderer, words: string) =>
    all(tree, 'Button').find((node) => String(node.props.children).includes(words));

  afterEach(() => {
    telegramBot = { bot: null, available: true };
  });

  it('is its own card, apart from the person’s connected accounts', async () => {
    const tree = await render();
    expect(
      all(tree, 'AgentCreatorSection').some((node) => node.props.title === 'Telegram bot'),
    ).toBe(true);
  });

  it('connects a pasted @BotFather token, with the person’s say on who pays', async () => {
    api.put.mockResolvedValueOnce({ data: { bot } });
    const tree = await render();
    await act(async () => all(tree, 'TextFieldInput')[0]?.props.onChangeText(TOKEN));
    await act(async () =>
      switchLabelled(tree, 'Pay for its answers')?.props.onCheckedChange(false),
    );
    await act(async () => button(tree, 'Connect the bot')?.props.onPress());
    await settle();
    expect(api.put).toHaveBeenCalledWith('/agents/agent-1/telegram-bot', {
      token: TOKEN,
      ownerPaysAgentTurns: false,
    });
    expect(toast.success).toHaveBeenCalledWith('Scout answers on Telegram now.');
  });

  it('shows the bot as Telegram sees it, says what groups need, and removes it on confirm', async () => {
    telegramBot = { bot, available: true };
    api.delete.mockReset().mockResolvedValue({ data: {} });
    const tree = await render();
    const texts = all(tree, 'Text').map((node) => String(node.props.children));
    expect(texts).toContain('@scout_bot');
    expect(all(tree, 'Badge')[0]?.props).toMatchObject({ content: 'Connected', color: 'success' });
    // Privacy mode is on: the groups row says what it needs as a notice of its own.
    expect(
      all(tree, 'Admonition').some((node) => String(node.props.children).includes('/setprivacy')),
    ).toBe(true);

    confirm.mockResolvedValueOnce(true);
    await act(async () => button(tree, 'Remove')?.props.onPress());
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/telegram-bot');
  });

  it('says when Telegram cannot deliver, with its reason', async () => {
    telegramBot = {
      bot: { ...bot, live: { ...bot.live, webhook: 'failing', webhookError: '502 Bad Gateway' } },
      available: true,
    };
    const tree = await render();
    expect(all(tree, 'Badge')[0]?.props).toMatchObject({ content: 'Error', color: 'error' });
    const notice = all(tree, 'Admonition').find((node) => node.props.type === 'error');
    expect(String(notice?.props.children)).toContain('502 Bad Gateway');
  });

  it('follows the gemie by itself: no sync control, only a failure with a retry', async () => {
    telegramBot = { bot, available: true };
    let tree = await render();
    expect(button(tree, 'Sync')).toBeUndefined();
    expect(button(tree, 'Try again now')).toBeUndefined();
    act(() => tree.unmount());

    telegramBot = {
      bot: { ...bot, profileSyncError: 'Too Many Requests: retry after 30' },
      available: true,
    };
    api.patch.mockReset().mockResolvedValue({ data: { bot } });
    tree = await render();
    const notice = all(tree, 'Admonition').find((node) =>
      String(node.props.children).includes('Too Many Requests'),
    );
    expect(String(notice?.props.children)).toContain('It keeps trying by itself');
    await act(async () => button(tree, 'Try again now')?.props.onPress());
    await settle();
    expect(api.patch).toHaveBeenCalledWith('/agents/agent-1/telegram-bot', {
      retryProfileSync: true,
    });
  });

  it('offers to link the person’s Telegram only while nobody is linked, and says who is', async () => {
    telegramBot = { bot, available: true };
    let tree = await render();
    expect(button(tree, 'Link my Telegram')).toBeDefined();
    act(() => tree.unmount());

    telegramBot = { bot: { ...bot, personLinked: true, linkedAs: '@nate' }, available: true };
    tree = await render();
    expect(button(tree, 'Link my Telegram')).toBeUndefined();
    expect(button(tree, 'Link another account')).toBeDefined();
    expect(button(tree, 'Unlink')).toBeDefined();
    const texts = all(tree, 'Text').map((node) => String(node.props.children));
    expect(texts.some((text) => /^Linked as @nate\. Scout recognises you/.test(text))).toBe(true);
    expect(button(tree, 'Reauthorise')).toBeUndefined();
  });

  it('says when the permission given on the bot lapsed, and renews it in one tap', async () => {
    telegramBot = {
      bot: { ...bot, personLinked: true, linkedAs: '@nate', personAuthorityLapsed: true },
      available: true,
    };
    const tree = await render();
    expect(
      all(tree, 'Admonition').some((node) =>
        String(node.props.children).includes('the permission you gave it there lapsed'),
      ),
    ).toBe(true);
    await act(async () => {
      await button(tree, 'Reauthorise')?.props.onPress();
    });
    expect(reauthorize.mutateAsync).toHaveBeenCalledTimes(1);
  });
});
