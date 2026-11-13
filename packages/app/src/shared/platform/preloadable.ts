import {
  type ComponentType,
  createElement,
  lazy,
  type ReactElement,
  useEffect,
  useState,
} from 'react';
import { Platform } from 'react-native';

/**
 * A component in its own chunk, fetched before it is needed.
 *
 * For a surface no first paint draws (an editor, a dialog, a panel): on the web it stays out of the
 * JS every route loads first, and `preload()` (on intent, or `usePreloadWhenIdle`) fetches it
 * ahead, so opening it does not wait on the network. Once loaded it renders directly, without a
 * suspended frame. Rendered before it has loaded, it suspends: wrap it in a `Suspense` whose
 * fallback is the surface's skeleton.
 *
 * A native bundle holds every module already, so there it loads at once, as a static import would.
 */
export type Preloadable<P extends object> = ((props: P) => ReactElement) & {
  preload: () => Promise<unknown>;
};

export function preloadable<P extends object>(
  load: () => Promise<ComponentType<P>>,
): Preloadable<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const preload = () => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        // Forget a failed fetch (offline, a deploy replaced the chunk): the next render asks again.
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  function Component(props: P) {
    // Fixed per instance, so the element type never changes under a mounted surface.
    const [ready] = useState(() => loaded);
    return createElement((ready ?? Lazy) as ComponentType<P>, props);
  }
  if (Platform.OS !== 'web') preload().catch(() => {});
  return Object.assign(Component, { preload });
}

/** Long enough for the first paint and its own requests to go first. */
const IDLE_TIMEOUT_MS = 4000;

/**
 * Fetches a `preloadable` once the page is idle after mount (web; native has it already), while
 * `enabled` (a surface only a signed-in person can open is not fetched for anyone else).
 */
export function usePreloadWhenIdle(component: { preload: () => Promise<unknown> }, enabled = true) {
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const preload = () => {
      // Ahead of time only: a failure is forgotten, and the first render fetches it again.
      component.preload().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preload, { timeout: IDLE_TIMEOUT_MS });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = setTimeout(preload, IDLE_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [component, enabled]);
}
