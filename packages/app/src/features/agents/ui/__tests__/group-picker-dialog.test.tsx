import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(),
  error: vi.fn(),
  agents: Array.from({ length: 7 }, (_, index) => ({ _id: String(index), name: `Gemie ${index}` })),
}));
vi.mock('@/features/agents/runtime/use-my-agents', () => ({
  useMyAgents: () => ({ data: state.agents }),
}));
vi.mock('@/features/agents/runtime/use-start-group', () => ({
  useStartGroup: () => ({ start: state.start, starting: false }),
}));
vi.mock('@/features/agents/model/identity', () => ({
  agentDisplayName: (agent: { name: string }) => agent.name,
}));
vi.mock('@/features/chat/runtime/ui-store', () => ({
  useUIStore: (selector: (ui: object) => unknown) =>
    selector({ groupPickerOpen: true, setGroupPickerOpen: state.close }),
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@gemies/sdk', () => ({ readAgentCharacter: () => ({ preset: 'blue_beret' }) }));
vi.mock('react-native', () => ({ View: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@oxy.so/bloom/agent-avatar', () => ({ AgentAvatar: () => null }));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({ useAvatarFlights: () => undefined }));
vi.mock('@oxy.so/bloom/multi-agent-chat/selected-agent-preview', () => ({
  SelectedAgentPreview: () => null,
}));
vi.mock('@oxy.so/bloom/typography', () => ({ Muted: () => null }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: state.error } }));
vi.mock('@oxy.so/bloom/list', () => ({
  List: (props: object) => React.createElement('List', props),
}));
vi.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: ({ children, ...props }: React.PropsWithChildren) =>
    React.createElement('Dialog', props, children),
}));

import { GroupPickerDialog } from '../group-picker-dialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.clearAllMocks();
  state.start.mockResolvedValue(undefined);
  act(() => {
    renderer = create(<GroupPickerDialog />);
  });
});
afterEach(() => act(() => renderer.unmount()));
const rows = () =>
  renderer.root.findByType('List' as never).props.items as Array<{
    id: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }>;
const createAction = () => renderer.root.findByType('Dialog' as never).props.actions[0];

describe('group member selection', () => {
  it('selects through List, keeps the six-member limit, and submits the chosen identities once', async () => {
    expect(createAction().disabled).toBe(true);
    for (let index = 0; index < 7; index++) act(() => rows()[index]!.onCheckedChange(true));
    expect(
      rows()
        .filter((row) => row.checked)
        .map((row) => row.id),
    ).toEqual(['0', '1', '2', '3', '4', '5']);
    // Repeated checked notifications preserve the choice; deselection makes room for another gemie.
    act(() => rows()[0]!.onCheckedChange(true));
    act(() => rows()[0]!.onCheckedChange(false));
    act(() => rows()[6]!.onCheckedChange(true));
    expect(createAction().disabled).toBe(false);
    await act(async () => {
      createAction().onPress();
    });
    expect(state.start).toHaveBeenCalledExactlyOnceWith(['1', '2', '3', '4', '5', '6']);
    expect(state.close).toHaveBeenCalledExactlyOnceWith(false);
    expect(rows().some((row) => row.checked)).toBe(false);
  });

  it('keeps the selected members when creating the conversation fails, so the user can retry', async () => {
    act(() => rows()[0]!.onCheckedChange(true));
    act(() => rows()[1]!.onCheckedChange(true));
    state.start.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => {
      createAction().onPress();
    });
    expect(state.close).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith('group.startFailed');
    expect(
      rows()
        .filter((row) => row.checked)
        .map((row) => row.id),
    ).toEqual(['0', '1']);
    await act(async () => {
      createAction().onPress();
    });
    expect(state.start).toHaveBeenLastCalledWith(['0', '1']);
    expect(state.close).toHaveBeenCalledExactlyOnceWith(false);
  });
});
