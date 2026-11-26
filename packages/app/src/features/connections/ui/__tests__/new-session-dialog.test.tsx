import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  open: vi.fn(),
  push: vi.fn(),
  onClose: vi.fn(),
  error: vi.fn(),
  folders: ['/home/ana/app', '/home/ana/api'],
}));
vi.mock('@/features/connections/runtime/use-external-sessions', () => ({
  // The real rule: absolute on the agent's computer.
  isSessionFolder: (path: string) => /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(path.trim()),
  useExternalSessions: () => ({
    folders: state.folders,
    loadingFolders: false,
    open: state.open,
    opening: false,
  }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native', () => ({ View: ({ children }: React.PropsWithChildren) => children }));
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

beforeEach(() => {
  vi.clearAllMocks();
  state.open.mockResolvedValue('conv-9');
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
});
afterEach(() => act(() => renderer.unmount()));

const field = () => renderer.root.findByType('TextFieldInput' as never);
const dialog = () => renderer.root.findByType('Dialog' as never);
const startAction = () => dialog().props.actions[0];
const recent = () =>
  renderer.root.findByType('List' as never).props.items as Array<{
    id: string;
    onPress: () => void;
  }>;
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
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/(app)/c/conv-9');
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
