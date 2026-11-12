/**
 * The ask provider of `@gemies/sdk/ask`: its sheet is loaded lazily and mounted on the first
 * `ask`, so an app that mounts this provider at its root keeps the chat out of its entry bundle.
 * Signed in, the sheet's module is fetched in the background so the first `ask` does not wait on
 * the network.
 *
 * This `import()` is the ONE async boundary the SDK draws, and only for this entry (and
 * `@gemies/sdk/ask/text`): everything behind it (`GemieAskSheetWithVoice` and the chat) imports statically on web, so Metro emits one chunk for
 * the sheet and hoists nothing of it into `__common.js` (`scripts/check-entry-isolation.mjs`).
 */

import { lazy, Suspense } from 'react';
import { type AskSheetComponent, createAskProvider } from './GemieAskCore';

const loadSheet = () => import('./GemieAskSheetWithVoice');
const LazyAskSheet = lazy(() => loadSheet().then((module) => ({ default: module.GemieAskSheet })));

const SuspendedAskSheet: AskSheetComponent = (props) => (
  <Suspense fallback={null}>
    <LazyAskSheet {...props} />
  </Suspense>
);

export type { GemieAsk, GemieAskAgents, GemieAskProviderProps } from './GemieAskCore';
export { useAskGemie } from './GemieAskCore';

export const GemieAskProvider = createAskProvider(SuspendedAskSheet, loadSheet);
