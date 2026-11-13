import { AgentEditorLoading } from '@/features/agents/ui/edit/agent-editor-load-states';
import { preloadable } from '@/shared/platform/preloadable';
import { Suspense, type ComponentProps } from 'react';
import type { AgentEditorLoader } from './agent-editor-loader';

/**
 * The agent editor in its own chunk. It brings Bloom's agent creator (~400 KB on the web), and the
 * right panel that hosts it is in the layout every route loads: imported statically, it was in the
 * first paint of every screen, editor or not. The shell fetches it once the page is idle
 * (`usePreloadWhenIdle` in the app layout), so opening the editor does not wait on it.
 */
export const LazyAgentEditorLoader = preloadable<ComponentProps<typeof AgentEditorLoader>>(() =>
  import('./agent-editor-loader').then((module) => module.AgentEditorLoader),
);

/** The editor, or its skeleton for the moment its chunk is still on the way. */
export function AgentEditorSurface(props: ComponentProps<typeof AgentEditorLoader>) {
  return (
    <Suspense fallback={<AgentEditorLoading />}>
      <LazyAgentEditorLoader {...props} />
    </Suspense>
  );
}
