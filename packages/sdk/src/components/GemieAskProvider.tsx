/**
 * The ask provider of the root entry (`@gemies/sdk`): its sheet is a static import.
 *
 * The root entry already holds the whole chat, so loading `GemieAskSheet` lazily here would save
 * nothing and cost a lot on web: it is an async chunk boundary inside the SDK, and Metro hoists
 * every module two async chunks share into `__common.js`, which loads at first paint. An app that
 * lazy-loads its Alia sheet would then get the chat (and the Bloom it draws with) in its first
 * paint. An app that wants the chat out of its entry bundle mounts the provider from
 * `@gemies/sdk/ask` (`GemieAskProviderLazy`) instead. See `GemieAskCore` for the provider itself.
 */

import { createAskProvider } from './GemieAskCore';
import { GemieAskSheet } from './GemieAskSheetWithVoice';

export type { GemieAsk, GemieAskAgents, GemieAskProviderProps } from './GemieAskCore';
export { useAskGemie } from './GemieAskCore';

export const GemieAskProvider = createAskProvider(GemieAskSheet);
