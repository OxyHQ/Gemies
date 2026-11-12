/**
 * The ask provider of `@gemies/sdk/ask/text`: `GemieAskProviderLazy` without the voice call. Its
 * sheet is loaded lazily, with the first `ask`, and neither the provider nor the sheet reaches the
 * call's modules, so a text-only app bundles none of them.
 *
 * Its `import()` is the one async boundary of this entry, as in `GemieAskProviderLazy`: behind it
 * everything imports statically on web (`scripts/check-entry-isolation.mjs`).
 */

import { lazy, Suspense } from 'react';
import { type AskSheetComponent, createAskProvider } from './GemieAskCore';

const loadSheet = () => import('./GemieAskSheet');
const LazyAskSheet = lazy(() => loadSheet().then((module) => ({ default: module.GemieAskSheet })));

const SuspendedAskSheet: AskSheetComponent = (props) => (
  <Suspense fallback={null}>
    <LazyAskSheet {...props} />
  </Suspense>
);

export type { GemieAsk, GemieAskAgents, GemieAskProviderProps } from './GemieAskCore';
export { useAskGemie } from './GemieAskCore';

export const GemieAskProvider = createAskProvider(SuspendedAskSheet, loadSheet);
