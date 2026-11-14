/**
 * The state shapes of one voice call: the upstream session, the turns the
 * voice handed over and the call's lifecycle states. Types only; the
 * transitions are `VoiceCall`'s (`call.ts`).
 */
import type { RealtimeSession } from '@kaana.ai/sdk';

export interface UpstreamState {
  readonly session: RealtimeSession;
  requestId: string | null;
  createdAt: number | null;
  /** When it ended; the minutes between are what the session costs. */
  endedAt: number | null;
}

/** How a delegated turn ended. */
export type DelegationOutcome = 'answered' | 'superseded' | 'failed' | 'dropped';

/** One `delegation.requested`, answered by one chat turn (ADR 0041 §2). */
export interface DelegationState {
  readonly delegationId: string;
  /** The chat turn's control id: what the app's Stop names too. */
  readonly turnId: string;
  /** The person's words are stored under this id, and every user transcript of them names it. */
  readonly userMessageId: string;
  /** The answer is stored under this id, and every answer transcript and tool event names it. */
  readonly assistantMessageId: string;
  readonly controller: AbortController;
  /** The person moved on: nothing more is sent for it. */
  superseded: boolean;
  /** The last voice audio item heard while it was the current turn. */
  lastAudioItem: string | null;
}

/**
 * Words of a turn that was superseded before the chat route stored it: they
 * open the next turn, unless the stored conversation shows they made it.
 */
export interface CarriedWords {
  readonly messageId: string;
  readonly text: string;
}

export type CallState = 'idle' | 'opening' | 'live' | 'reconnecting' | 'closing' | 'closed';
