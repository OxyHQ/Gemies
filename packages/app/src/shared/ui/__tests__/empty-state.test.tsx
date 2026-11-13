import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * Bloom's character functions as they behave, beside a host `AgentAvatar` (the real one needs a
 * native renderer): a preset key paints the body and drops any other paint, an unknown colour leaves
 * the character as it is, and the parser refuses what has neither a preset nor a paint, as
 * `resolveAvatarCharacter` does.
 */
const drawable = (character: Record<string, unknown>) =>
  character.preset !== undefined ||
  character.color !== undefined ||
  character.bodyColor !== undefined;
vi.mock('@oxy.so/bloom/agent-avatar', async () => {
  const ReactModule = await import('react');
  return {
    AgentAvatar: (props: object) => ReactModule.createElement('AgentAvatar', props),
    avatarCharacterInColor: (character: Record<string, unknown>, color: unknown) => {
      if (typeof color !== 'string') return character;
      const { color: _color, bodyColor: _bodyColor, ...parts } = character;
      return { ...parts, color };
    },
    parseAvatarCharacter: (value: Record<string, unknown>) => {
      if (!drawable(value)) throw new Error('A character without a preset needs a color.');
      return value;
    },
  };
});
vi.mock('@oxy.so/bloom/empty-state', async () => {
  const ReactModule = await import('react');
  return {
    EmptyState: (props: object) => ReactModule.createElement('BloomEmptyState', props),
    EMPTY_STATE_GEOMETRY: { comfortable: { illustration: 112 }, compact: { illustration: 72 } },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { DEFAULT_AGENT_CHARACTER, readAgentCharacter } = await import('@gemies/sdk/character');
const { EmptyState } = await import('../empty-state');

const render = (element: React.ReactElement) => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(element);
  });
  return renderer.root;
};

describe('EmptyState', () => {
  it('draws the default gemie saying no above the text, decorative', () => {
    const onPress = vi.fn();
    const root = render(
      <EmptyState title="Gemie not found" action={{ label: 'Back to Gemies', onPress }} />,
    );
    const block = root.findByType('BloomEmptyState' as never);
    expect(block.props).toMatchObject({
      title: 'Gemie not found',
      action: { label: 'Back to Gemies', onPress },
    });
    // Bloom draws the illustration as it comes: the gemie is that element.
    expect(block.props.illustration.props).toMatchObject({
      character: readAgentCharacter(null, null),
      mood: 'sad',
      size: 112,
      accessibilityLabel: '',
    });
  });

  it('hands Bloom a gemie it can draw: the default look, painted in the default colour', () => {
    // Bloom throws on a character with neither a preset nor a paint, and the throw takes the whole
    // app down (gemies.ai/shows, a profile, «Gemie not found»). The bare look has no paint.
    const root = render(<EmptyState title="Nothing here" />);
    const { character } = root.findByType('BloomEmptyState' as never).props.illustration.props;
    expect(drawable(DEFAULT_AGENT_CHARACTER)).toBe(false);
    expect(character).toMatchObject({ shape: DEFAULT_AGENT_CHARACTER.shape });
    expect(drawable(character)).toBe(true);
  });

  it('sizes the gemie to the panel rung', () => {
    const root = render(<EmptyState variant="compact" title="Could not load the catalogue." />);
    const block = root.findByType('BloomEmptyState' as never);
    expect(block.props.illustration.props.size).toBe(72);
  });
});
