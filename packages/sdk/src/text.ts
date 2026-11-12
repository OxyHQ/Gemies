/// <reference types="nativewind/types" />
// @gemies/sdk/text — the chat without the voice call, and without bundling it
// The same `GemieChatSheet`, `GemieChatScreen` and `GemieChatContent` as the root entry, but none of
// them reaches the call's modules (its socket, protocol and audio engine): a text-only app takes
// its chat from here. Read-aloud and dictation stay — they are the composer's and the thread's.
// Types can be imported from the root entry (they are erased); values from the root would bring
// the call along.

export { GemieChatContent } from './components/GemieChatContent';
export type {
  GemieChatAgentRef,
  GemieChatChrome,
  GemieChatContentProps,
  GemieChatState,
} from './components/GemieChatContent';
export { GemieChatSheet } from './components/GemieChatSheet';
export type { GemieChatSheetProps, GemieChatSheetRef } from './components/GemieChatSheet';
export { GemieChatScreen } from './components/GemieChatScreen';
export type { GemieChatScreenProps } from './components/GemieChatScreen';
