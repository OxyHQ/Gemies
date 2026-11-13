import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/bloom/agent-avatar', async () => {
  const ReactModule = await import('react');
  return { AgentAvatar: (props: object) => ReactModule.createElement('AgentAvatar', props) };
});
vi.mock('@oxy.so/bloom/empty-state', async () => {
  const ReactModule = await import('react');
  return {
    EmptyState: (props: object) => ReactModule.createElement('BloomEmptyState', props),
    EMPTY_STATE_GEOMETRY: { comfortable: { illustration: 112 }, compact: { illustration: 72 } },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { DEFAULT_AGENT_CHARACTER } = await import('@gemies/sdk/character');
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
      character: DEFAULT_AGENT_CHARACTER,
      mood: 'sad',
      size: 112,
      accessibilityLabel: '',
    });
  });

  it('sizes the gemie to the panel rung', () => {
    const root = render(<EmptyState variant="compact" title="Could not load the catalogue." />);
    const block = root.findByType('BloomEmptyState' as never);
    expect(block.props.illustration.props.size).toBe(72);
  });
});
