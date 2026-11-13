/**
 * Realtime: the one socket a signed-in client holds to Gemies (`docs/realtime.mdx`). Mounted by
 * `GemieRuntimeProvider`; a host listens with the hooks below for what is its own (credits, its
 * lists, notifications), while the runtime's conversations, reactions, rooms and "typing…" are
 * kept live by the SDK itself.
 */

export {
  GemieRealtimeProvider,
  useGemieRealtime,
  useRealtimeEvent,
  useRealtimeReset,
  useRealtimeTopic,
} from './react';
export {
  useConversationActivity,
  useRealtimeActivityStore,
  type ActorActivityEntry,
} from './activity';
export type { RealtimeConnection, RealtimeListener } from './connection';
export {
  REALTIME_DURABLE_TYPES,
  REALTIME_SIGNAL_TYPES,
  type ActivityState,
  type RealtimeActivity,
  type RealtimeConversationRow,
  type RealtimeData,
  type RealtimeDurableType,
  type RealtimeFrame,
  type RealtimeSignalType,
  type RealtimeThreadTotal,
  type RealtimeType,
} from './contract';
