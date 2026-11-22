import { type Action, type ActionView, useAction } from '@oxy.so/bloom-data';
import { useCallback, useRef } from 'react';

/**
 * An action whose first argument is the provider's client (the API, or the conversation client),
 * as a component calls it: `run` takes the rest. `onFailure` hears every refusal (a toast), which
 * `run` still rejects with.
 */
export function useBoundAction<C, A extends unknown[], R>(
  action: Action<[C, ...A], R>,
  client: C,
  onFailure?: (error: unknown) => void,
): ActionView<A, R> {
  const view = useAction(action);
  const failure = useRef(onFailure);
  failure.current = onFailure;
  const bound = view.run;
  const run = useCallback(
    (...args: A) =>
      bound(client, ...args).catch((error: unknown) => {
        failure.current?.(error);
        throw error;
      }),
    [bound, client],
  );
  return { ...view, run };
}
