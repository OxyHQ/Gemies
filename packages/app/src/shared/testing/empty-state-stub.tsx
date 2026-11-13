import React from 'react';
import type { EmptyStateProps } from '@/shared/ui/empty-state';

type Action = NonNullable<EmptyStateProps['action']>;

const button = (action: Action) =>
  React.createElement(
    'Button',
    {
      key: action.label,
      accessibilityLabel: action.accessibilityLabel ?? action.label,
      onPress: action.onPress,
    },
    React.createElement('Text', null, action.label),
  );

/**
 * The app's `EmptyState` (`@/shared/ui/empty-state`) as host elements, for a suite about the
 * screen that shows one rather than about the gemie above it: an `EmptyState` carrying its props,
 * its title and description as `Text`, and each action as a `Button` named by its label.
 *
 * Used from `vi.mock` factories via `await import('@/shared/testing/empty-state-stub')`.
 */
export function emptyStateModule() {
  return {
    EmptyState: (props: EmptyStateProps) =>
      React.createElement(
        'EmptyState',
        props,
        props.title ? React.createElement('Text', null, props.title) : null,
        props.description ? React.createElement('Text', null, props.description) : null,
        ...[props.action, props.secondaryAction].filter((a): a is Action => !!a).map(button),
      ),
  };
}
