import { DEFAULT_AGENT_CHARACTER } from '@gemies/sdk/character';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import {
  EmptyState as BloomEmptyState,
  EMPTY_STATE_GEOMETRY,
  type EmptyStateProps as BloomEmptyStateProps,
} from '@oxy.so/bloom/empty-state';

export type EmptyStateProps = Omit<BloomEmptyStateProps, 'illustration' | 'icon' | 'media'>;

/**
 * The app's empty, not-found and failed states: Bloom's `EmptyState` with a gemie above the text
 * that shakes its head "no" as the state appears and then stays downcast (`mood="sad"`). Under
 * reduced motion it is the downcast still, with no shake.
 *
 * The gemie is the default one, the look of a gemie whose own is not known: never Alia or anybody
 * else's, so "Gemie not found" does not show a gemie that was found. It is decorative, as the
 * glyph it replaces was: the block already announces its title and description as one group.
 */
export function EmptyState(props: EmptyStateProps) {
  return (
    <BloomEmptyState
      {...props}
      illustration={
        <AgentAvatar
          character={DEFAULT_AGENT_CHARACTER}
          size={EMPTY_STATE_GEOMETRY[props.variant ?? 'comfortable'].illustration}
          mood="sad"
          accessibilityLabel=""
        />
      }
    />
  );
}
