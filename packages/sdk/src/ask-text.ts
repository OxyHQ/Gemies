/// <reference types="nativewind/types" />
// @gemies/sdk/ask/text — `@gemies/sdk/ask` without the voice call, and without bundling it
// The provider and its hook; the sheet loads with the first `ask`, and neither reaches the call's
// modules. `useAskGemie` is the same hook as `@gemies/sdk/ask`'s.

export { GemieAskProvider, useAskGemie } from './components/GemieAskProviderText';
export type {
  GemieAsk,
  GemieAskAgents,
  GemieAskProviderProps,
} from './components/GemieAskProviderText';
