import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Alia's editor in the Gemies app (ADR 0035): who she is as text, never as fields (her identity is
 * Oxy's and the API refuses any edit of it), and the person's own connected accounts on her.
 */

const host = vi.hoisted(() => async (...names: string[]) => {
  const ReactModule = await import('react');
  return Object.fromEntries(
    names.map((name) => [
      name,
      ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        ReactModule.createElement(name, props, children as React.ReactNode),
    ]),
  );
});

vi.mock('react-native', async () => host('View', 'ScrollView'));
vi.mock('@oxy.so/bloom/typography', async () => host('Text'));
vi.mock('@oxy.so/bloom/button', async () => host('Button'));
vi.mock('@oxy.so/bloom/agent-avatar', async () => host('AgentAvatar'));
vi.mock('@oxy.so/bloom/icons/RiCloseLine', () => ({ RiCloseLine: 'RiCloseLine' }));
vi.mock('@gemies/sdk', async () => ({
  ALIA_GEMIE_ID: 'alia-gemie-id',
  ...(await host('GemieAvatar')),
  readAgentCharacter: () => ({ preset: 'blue_beret' }),
}));
vi.mock('@/features/agents/ui/edit/sections/agent-accounts-section', async () =>
  host('AgentAccountsSection'),
);
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));

import { LockedGemieEditor } from '../locked-gemie-editor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const ALIA = { _id: 'alia-gemie-id', name: null, handle: null, character: {}, tagline: '' };

describe('LockedGemieEditor', () => {
  it('shows Alia as text, offers her accounts and nothing that would save nothing', () => {
    const onClose = vi.fn();
    act(() => {
      renderer = create(<LockedGemieEditor agent={ALIA as never} onClose={onClose} />);
    });
    const root = renderer!.root;
    const texts = root
      .findAll((node) => (node.type as unknown) === 'Text')
      .map((node) => [node.props.children].flat().join(''));
    expect(texts).toContain('Alia');
    expect(texts).toContain('agents.editor.lockedIdentity {"name":"Alia"}');
    expect(root.findAll((node) => (node.type as unknown) === 'GemieAvatar')).toHaveLength(1);
    expect(root.findByType('AgentAccountsSection' as never).props).toEqual({
      agentId: 'alia-gemie-id',
      name: 'Alia',
    });
    // No input of any kind: the only control is closing.
    for (const field of ['TextInput', 'TextFieldInput', 'Switch', 'Textarea', 'AgentCreator']) {
      expect(root.findAll((node) => (node.type as unknown) === field)).toHaveLength(0);
    }
    act(() => root.findByType('Button' as never).props.onPress());
    expect(onClose).toHaveBeenCalled();
  });
});
