/**
 * What a voice call is bound by and what it needs from the world: the product
 * limits (ADR 0017 §3), the upstream session's ceilings, the end-reason map and
 * the shapes `VoiceCall` takes (client sink, environment, start). `call.ts`
 * re-exports the public ones.
 */
import type { VoiceCallEndReason } from '../../db/schema/voice.js';
import type { PrefetchedTurnInputs, TurnIdentity } from '../chat/turn-inputs.js';
import type { KaanaClient } from '../kaana/port.js';
import type { startCall } from './call-registry.js';
import type { VoiceCreditDeps } from './credits.js';
import type { VoiceTurnRunner } from './delegated-turn.js';
import type { HistoryMessage } from './persona.js';
import {
  type ProductVoice,
  type SequencedVoiceEvent,
  VOICE_BYTES_PER_MS,
  type VoiceCloseReason,
} from './protocol.js';

/**
 * Alia's product rules for every call (ADR 0017 §3, "Limits"). Not capacity
 * limits: concurrency and spend are the Alia app's policy in Oxy Console.
 */
export interface VoiceCallLimits {
  readonly maxDurationMs: number;
  readonly idleTimeoutMs: number;
  /** The client is told this long before the duration ends. */
  readonly warningBeforeMs: number;
  /** A dropped socket may resume within this. */
  readonly resumeWindowMs: number;
  /**
   * How long a delegated turn waits for the one it superseded to settle before
   * it reads the stored conversation, so it never sends a history that a
   * finishing turn is still writing to.
   */
  readonly settleWaitMs: number;
  readonly creditCheckMs: number;
  /** New upstream sessions one call may open after the first. */
  readonly maxReopens: number;
  /** Events kept for a resume. */
  readonly replayEvents: number;
}

export const VOICE_CALL_LIMITS: VoiceCallLimits = {
  maxDurationMs: 30 * 60_000,
  idleTimeoutMs: 2 * 60_000,
  warningBeforeMs: 60_000,
  resumeWindowMs: 30_000,
  settleWaitMs: 5_000,
  creditCheckMs: 15_000,
  maxReopens: 2,
  replayEvents: 500,
};

/** The upstream session's ceilings, signed per session (ADR 0017 §3 table). */
export function sessionLimits(maxDurationMs: number, idleTimeoutMs: number) {
  const audioBytes = Math.ceil((maxDurationMs * VOICE_BYTES_PER_MS) / 1000) * 1000;
  return {
    maxDurationMs,
    idleTimeoutMs: Math.min(idleTimeoutMs, maxDurationMs),
    maxInputAudioBytes: audioBytes,
    maxOutputAudioBytes: audioBytes,
    maxResponses: 500,
  };
}

export const END_REASON: Readonly<Record<VoiceCloseReason, VoiceCallEndReason>> = {
  hangup: 'hangup',
  'call-moved-elsewhere': 'moved_elsewhere',
  'max-duration': 'max_duration',
  'idle-timeout': 'idle_timeout',
  'credits-exhausted': 'credits_exhausted',
  error: 'error',
  'server-shutdown': 'server_shutdown',
};

/* -------------------------------------------------------------------------- */
/*  What the call needs from the world                                         */
/* -------------------------------------------------------------------------- */

/** The client end of a call: the socket, or nothing while it is away. */
export interface VoiceClientSink {
  sendEvent(event: SequencedVoiceEvent): void;
  sendAudio(frame: Uint8Array): void;
  close(): void;
}

export interface VoiceCallEnvironment {
  readonly kaana: KaanaClient | null;
  prefetch(identity: TurnIdentity): Promise<PrefetchedTurnInputs>;
  readonly credits?: VoiceCreditDeps;
  startCall: typeof startCall;
  finishCall(callId: string, reason: VoiceCallEndReason): Promise<void>;
  loadHistory(oxyUserId: string, conversationId: string): Promise<HistoryMessage[]>;
  /**
   * The members of a group conversation (ADR 0025), none for any other. A call has one gemie, and
   * a group's turns are its members': a call there would answer as the default gemie, Alia, and
   * write her transcript into their conversation.
   */
  groupMembers(oxyUserId: string, conversationId: string): Promise<readonly string[]>;
  /** Every delegated turn runs, and is stored, through the chat route (ADR 0041 §2). */
  readonly turns: VoiceTurnRunner;
  recordAnalytics(record: {
    oxyUserId: string;
    conversationId: string;
    model: string;
    resolvedModelReference: string | null;
    latencyMs: number;
    errorClass: string | null;
  }): Promise<void>;
}

export interface VoiceCallStart {
  readonly conversationId: string;
  readonly agentId?: string;
  readonly voice: ProductVoice;
  readonly locale: string;
  /** The app the call comes from, by the socket's verified app assertion (ADR 0021), or `null`. */
  readonly surfaceApplicationId: string | null;
}
