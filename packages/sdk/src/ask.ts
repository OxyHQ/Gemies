/// <reference types="nativewind/types" />
// @gemies/sdk/ask — the app's one Alia sheet, without the chat in the entry bundle
// `GemieAskProvider` and `useAskGemie` alone: the sheet they open is loaded with the first `ask`.
// An app mounts the provider at its root from here rather than from the root entry, which
// would bring the whole chat along with it.

export { GemieAskProvider, useAskGemie } from './components/GemieAskProviderLazy';
export type {
  GemieAsk,
  GemieAskAgents,
  GemieAskProviderProps,
} from './components/GemieAskProviderLazy';
