import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  open: vi.fn(),
  push: vi.fn(),
  onClose: vi.fn(),
  error: vi.fn(),
  folders: ['/home/ana/app', '/home/ana/api'],
  allowed: [] as string[],
}));
vi.mock('@/features/connections/runtime/use-external-sessions', () => ({
  // The real rule: absolute on the agent's computer.
  isSessionFolder: (path: string) => /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(path.trim()),
  // The real rule: inside one of the roots the computer allows, judged only for plain absolute paths.
  isAllowedFolder: (path: string, roots: string[]) =>
    roots.length === 0 ||
    !path.startsWith('/') ||
    roots.some((root) => path === root || path.startsWith(`${root}/`)),
  useExternalSessions: () => ({
    folders: state.folders,
    allowedFolders: state.allowed,
    loadingFolders: false,
    open: state.open,
    opening: false,
  }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native', async () => ({
  ...(await import('@/shared/testing/style-stubs')).reactNativeStyles,
  View: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('@oxy.so/bloom/typography', () => ({
  Muted: ({ children }: React.PropsWithChildren) => React.createElement('Muted', null, children),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: state.error } }));
vi.mock('@oxy.so/bloom/text-field', () => ({
  TextFieldInput: (props: object) => React.createElement('TextFieldInput', props),
}));
vi.mock('@oxy.so/bloom/list', () => ({
  List: (props: object) => React.createElement('List', props),
}));
vi.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: ({ children, ...props }: React.PropsWithChildren) =>
    React.createElement('Dialog', props, children),
}));

import { NewSessionDialog } from '../new-session-dialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer;

function mount() {
  act(() => {
    renderer = create(
      <NewSessionDialog
        agentId="agent-1"
        name="Claude Code · laptop"
        open
        onClose={state.onClose}
      />,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.open.mockResolvedValue('conv-9');
  state.allowed = [];
  mount();
});
afterEach(() => act(() => renderer.unmount()));

const field = () => renderer.root.findByType('TextFieldInput' as never);
const dialog = () => renderer.root.findByType('Dialog' as never);
const startAction = () => dialog().props.actions[0];
type Rows = Array<{ id: string; onPress: () => void }>;
const lists = () => renderer.root.findAllByType('List' as never);
const rowsOf = (label: string) =>
  lists().find((list) => String(list.props.accessibilityLabel).endsWith(`.${label}`))?.props
    .items as Rows | undefined;
const recent = () => rowsOf('recent') as Rows;
const type = (value: string) => act(() => field().props.onValueChange(value));

describe('NewSessionDialog', () => {
  it('names the agent, and lists the recent folders to pick from', () => {
    expect(dialog().props.title).toContain('Claude Code · laptop');
    expect(recent().map((row) => row.id)).toEqual(['/home/ana/app', '/home/ana/api']);
  });

  it('picking a recent folder fills the field', () => {
    act(() => recent()[1]!.onPress());
    expect(field().props.value).toBe('/home/ana/api');
    expect(startAction().disabled).toBe(false);
  });

  it('blocks a path that is not absolute, and says so once the person tried', async () => {
    expect(startAction().disabled).toBe(true);
    type('app');
    expect(startAction().disabled).toBe(true);
    await act(async () => {
      startAction().onPress();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(field().props.invalid).toBe(true);
  });

  it('opens the session for the folder typed, then goes to that conversation', async () => {
    type('~/app');
    expect(startAction().disabled).toBe(false);
    await act(async () => {
      startAction().onPress();
    });
    expect(state.open).toHaveBeenCalledExactlyOnceWith('~/app');
    expect(state.onClose).toHaveBeenCalledTimes(1);
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/(app)/agents/agent-1');
  });

  it('stays open, with the folder kept, when the session cannot be opened', async () => {
    state.open.mockRejectedValueOnce(new Error('unavailable'));
    type('/home/ana/app');
    await act(async () => {
      startAction().onPress();
    });
    expect(state.error).toHaveBeenCalledWith(
      'settings.connections.externalAgents.session.startFailed',
    );
    expect(state.onClose).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
    expect(field().props.value).toBe('/home/ana/app');
  });
});

describe('NewSessionDialog: the folders its computer allows', () => {
  beforeEach(() => {
    act(() => renderer.unmount());
    state.allowed = ['/home/ana/code', '/srv/work'];
    mount();
  });

  it('offers them, ahead of the recent ones, and picking one fills the field', () => {
    expect(lists().map((list) => String(list.props.accessibilityLabel).split('.').pop())).toEqual([
      'allowed',
      'recent',
    ]);
    act(() => rowsOf('allowed')![1]!.onPress());
    expect(field().props.value).toBe('/srv/work');
    expect(startAction().disabled).toBe(false);
  });

  it('blocks a folder outside them before asking the server, and says how to allow it', async () => {
    type('/home');
    expect(startAction().disabled).toBe(true);
    await act(async () => {
      startAction().onPress();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(field().props.invalid).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('notAllowed');
  });

  it('lets in a folder under one, and a path it cannot judge', () => {
    type('/home/ana/code/app');
    expect(startAction().disabled).toBe(false);
    type('~/anything');
    expect(startAction().disabled).toBe(false);
    type('/home/ana/codex');
    expect(startAction().disabled).toBe(true);
  });
});
