/**
 * A voice call wired to `@kaana.ai/sdk/testing` — the real `Kaana` client
 * against Kaana's own rules in memory — a scripted chat route and in-memory
 * stores, for the voice suites. Everything the call reaches is here and
 * observable: the upstream `live` session (`session()`, the server's, which
 * the test drives with `emit`), the commands it applied (`commands(type)`),
 * the turns the chat route was asked for (`turns`), the events and audio the
 * client received (`sink`), the conversation as the chat route stored it
 * (`stored`), and the credit and registry calls.
 */

import { aliaGemie } from '../../../__tests__/support/gemies.js';
import { vi } from 'vitest';
import type { Model, RealtimeClientCommand } from '@kaana.ai/contracts';
import { createFakeKaana, type FakeKaanaServer, voiceCatalogue } from '@kaana.ai/sdk/testing';
import type { CreditReservation } from '../../credits-manager.js';
import type { KaanaClient } from '../../kaana/port.js';
import {
  type VoiceCallEnvironment,
  type VoiceCallLimits,
  type VoiceClientSink,
  VOICE_CALL_LIMITS,
  VoiceCall,
} from '../call.js';
import type { HeldCall } from '../call-registry.js';
import {
  type DelegatedTurnEvent,
  DelegatedTurnFailure,
  type DelegatedTurnRequest,
  type TurnCredentials,
  type VoiceTurnRunner,
} from '../delegated-turn.js';
import type { HistoryMessage } from '../persona.js';
import { decodeAssistantAudioFrame, type SequencedVoiceEvent } from '../protocol.js';

export class RecordingSink implements VoiceClientSink {
  readonly events: SequencedVoiceEvent[] = [];
  readonly audio: Uint8Array[] = [];
  closed = false;
  sendEvent(event: SequencedVoiceEvent): void {
    this.events.push(event);
  }
  sendAudio(frame: Uint8Array): void {
    this.audio.push(frame);
  }
  close(): void {
    this.closed = true;
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
  find<T extends SequencedVoiceEvent['type']>(
    type: T,
  ): Array<Extract<SequencedVoiceEvent, { type: T }>> {
    return this.events.filter((event) => event.type === type) as Array<
      Extract<SequencedVoiceEvent, { type: T }>
    >;
  }
  audioFor(itemId: string): number {
    return this.audio
      .map((frame) => decodeAssistantAudioFrame(frame))
      .filter((frame) => frame?.itemId === itemId)
      .reduce((sum, frame) => sum + (frame?.pcm.byteLength ?? 0), 0);
  }
}

/* -------------------------------------------------------------------------- */
/*  The chat route, scripted                                                   */
/* -------------------------------------------------------------------------- */

/** What the chat route answers one turn with: its events, as it streams them. */
export type TurnScript = (request: DelegatedTurnRequest) => AsyncIterable<DelegatedTurnEvent>;

/** An answer in words, streamed in the pieces given. */
export function say(...pieces: string[]): TurnScript {
  return async function* () {
    for (const text of pieces) yield { type: 'text', text };
  };
}

/** A turn that calls a tool, then answers. */
export function withTool(name: string, ok: boolean, ...pieces: string[]): TurnScript {
  return async function* () {
    yield { type: 'tool.started', callId: `call_${name}`, name };
    yield { type: 'tool.finished', callId: `call_${name}`, name, ok };
    for (const text of pieces) yield { type: 'text', text };
  };
}

/** A turn the chat route refuses or fails, typed. */
export function failing(code: string): TurnScript {
  // biome-ignore lint/correctness/useYield: a turn that fails before it streams anything
  return async function* () {
    throw new DelegatedTurnFailure(code, 503);
  };
}

/**
 * A turn that streams `first`, then waits for `release()` (or its abort) before
 * it streams `rest`. Aborted, it throws as `fetch` does.
 */
export function pausedAfter(first: string, ...rest: string[]) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const script: TurnScript = async function* (request) {
    yield { type: 'text', text: first };
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(request.signal.reason ?? new Error('aborted'));
      if (request.signal.aborted) abort();
      request.signal.addEventListener('abort', abort, { once: true });
      void gate.then(resolve);
    });
    for (const text of rest) yield { type: 'text', text };
  };
  return { script, release: () => release() };
}

/**
 * The chat route as the call sees it: every turn it was asked for, and the
 * conversation it stores — the person's message and the answer, appended when
 * a turn completes, exactly as `saveConversation` stores a typed turn.
 */
export class ScriptedChatRoute implements VoiceTurnRunner {
  readonly requests: DelegatedTurnRequest[] = [];
  readonly cancelled: Array<TurnCredentials & { turnId: string; conversationId: string }> = [];
  private readonly queue: TurnScript[] = [];

  constructor(
    readonly stored: HistoryMessage[],
    private readonly fallback: TurnScript = say('Vale.'),
  ) {}

  /** The next turns' answers, in order; after them every turn says the fallback. */
  answer(...scripts: TurnScript[]): void {
    this.queue.push(...scripts);
  }

  run(request: DelegatedTurnRequest): AsyncIterable<DelegatedTurnEvent> {
    this.requests.push(request);
    const script = this.queue.shift() ?? this.fallback;
    const stored = this.stored;
    return (async function* () {
      let answer = '';
      for await (const event of script(request)) {
        if (event.type === 'text') answer += event.text;
        yield event;
      }
      request.signal.throwIfAborted();
      stored.push(request.messages.at(-1)!, {
        id: request.assistantMessageId,
        role: 'assistant',
        content: answer,
      });
    })();
  }

  async cancel(turn: TurnCredentials & { turnId: string; conversationId: string }) {
    this.cancelled.push(turn);
  }
}

/* -------------------------------------------------------------------------- */
/*  The catalogue                                                              */
/* -------------------------------------------------------------------------- */

/** Kaana's realtime voice line in its own catalogue: what a `live` line is built from. */
const REALTIME = voiceCatalogue.find((model) => model.capabilities.realtime)!;

/**
 * A `live` line (Kaana ADR 0012 §1): Kaana's realtime line under its own id,
 * holding `live` sessions, the default of the kind when `isDefault`, with a
 * reviewed female and male voice.
 */
export function liveLine(
  modelId: string,
  options: { isDefault?: boolean; usdPerMinute?: string; voices?: Model['audio'] } = {},
): Model {
  const realtime = REALTIME.capabilities.realtime!;
  return {
    ...REALTIME,
    modelId,
    pricePerMinute: { amount: options.usdPerMinute ?? '0.05', currency: 'USD' },
    capabilities: {
      ...REALTIME.capabilities,
      realtime: {
        ...realtime,
        sessionKinds: ['live'],
        ...(options.isDefault ? { defaultKinds: ['live'] } : {}),
      },
    },
    audio: options.voices ?? {
      ...REALTIME.audio!,
      voices: [
        { id: `${modelId.split('/')[1]}-unreviewed`, name: 'Unreviewed', languages: ['en'] },
        {
          id: `${modelId.split('/')[1]}-female`,
          name: 'Female',
          languages: ['en'],
          gender: 'female',
        },
        { id: `${modelId.split('/')[1]}-male`, name: 'Male', languages: ['en'], gender: 'male' },
      ],
    },
  } as Model;
}

/** The catalogue's default `live` line, and a second line that is its fallback. */
export const LIVE_DEFAULT = liveLine('test-voice/live-default', { isDefault: true });
export const LIVE_FALLBACK = liveLine('test-voice/live-fallback', { usdPerMinute: '0.01' });

/** A catalogue like production's: dictation lines, a `conversation` line and two `live` lines. */
export const LIVE_CATALOGUE: readonly Model[] = [LIVE_FALLBACK, ...voiceCatalogue, LIVE_DEFAULT];

/** A dictation-only model of Kaana's own voice catalogue, by id. */
export function catalogueModel(modelId: string): Model {
  const model = voiceCatalogue.find((entry) => entry.modelId === modelId);
  if (!model) throw new Error(`No ${modelId} in Kaana's voice catalogue`);
  return model;
}

/* -------------------------------------------------------------------------- */
/*  The harness                                                                */
/* -------------------------------------------------------------------------- */

export interface HarnessOptions {
  /** The catalogue Kaana serves; {@link LIVE_CATALOGUE} by default. */
  models?: readonly Model[];
  /** No Kaana client at all, as a process with no Oxy service identity. */
  noKaana?: boolean;
  /**
   * The client the call is given, around the fake's: how a test has Kaana
   * answer what its rules alone never produce (a billing refusal), with the
   * SDK's own error classes.
   */
  wrapKaana?: (kaana: KaanaClient) => KaanaClient;
  voiceMode?: boolean;
  entitlementsUnavailable?: boolean;
  turnAgent?: Awaited<ReturnType<VoiceCallEnvironment['prefetch']>>['turnAgent'];
  reserve?: (userId: string, credits: number) => Promise<CreditReservation | null>;
  /** The conversation as stored before the call. */
  history?: HistoryMessage[];
  limits?: Partial<VoiceCallLimits>;
  /** The call's clock. */
  now?: () => number;
}

export function harness(options: HarnessOptions = {}) {
  const fake = createFakeKaana({ models: options.models ?? LIVE_CATALOGUE });
  const server: FakeKaanaServer = fake.server;
  const kaana = options.noKaana ? null : (options.wrapKaana?.(fake.kaana) ?? fake.kaana);
  /** The upstream session the call opened last. */
  const session = () => {
    const last = server.sessions.at(-1);
    if (!last) throw new Error('No upstream session was opened');
    return last;
  };
  /** The commands of one type the last session applied. */
  const commands = <T extends RealtimeClientCommand['type']>(type: T) =>
    session().commands.filter((command) => command.type === type) as Array<
      Extract<RealtimeClientCommand, { type: T }>
    >;
  const reservations: CreditReservation[] = [];
  const reserve = vi.fn(
    options.reserve ??
      (async (userId: string, credits: number): Promise<CreditReservation> => {
        const reservation: CreditReservation = {
          userId,
          creditsReserved: credits,
          initialFreeCredits: 0,
          initialPaidCredits: 1_000,
          grantKind: 'paid_balance',
        };
        reservations.push(reservation);
        return reservation;
      }),
  );
  const finalize = vi.fn(async (_reservation: CreditReservation, _credits: number) => undefined);
  const refund = vi.fn(async (_reservation: CreditReservation) => undefined);
  let heldCall: HeldCall | null = null;
  const startCall = vi.fn(async (input: { call: HeldCall }) => {
    heldCall = input.call;
    return { replaced: 0 };
  });
  const finishCall = vi.fn(async () => undefined);
  const stored: HistoryMessage[] = [...(options.history ?? [])];
  const turns = new ScriptedChatRoute(stored);
  /** What each call asked its turn inputs for: the person, the agent and the app. */
  const prefetched: Parameters<VoiceCallEnvironment['prefetch']>[0][] = [];
  const loadHistory = vi.fn(async () => [...stored]);
  const recordAnalytics = vi.fn(async () => undefined);

  const env: VoiceCallEnvironment = {
    kaana,
    prefetch: async (identity) => {
      prefetched.push(identity);
      return {
        userMemory: null,
        oxyUser: null,
        entitlements: options.entitlementsUnavailable
          ? null
          : {
              features: { 'voice-mode': options.voiceMode ?? true },
              planId: options.voiceMode === false ? 'free' : 'go',
              entitlement: {} as never,
            },
        turnAgent: options.turnAgent ?? { kind: 'agent', agent: aliaGemie() },
      };
    },
    credits: { reserve, finalize, refund },
    startCall: startCall as unknown as VoiceCallEnvironment['startCall'],
    finishCall,
    loadHistory,
    groupMembers: async (_oxyUserId, conversationId) =>
      conversationId.startsWith('group-') ? ['gemie-a', 'gemie-b'] : [],
    turns,
    recordAnalytics,
  };
  const sink = new RecordingSink();
  const call = new VoiceCall(
    env,
    'user-1',
    'token-1',
    { ...VOICE_CALL_LIMITS, ...options.limits },
    options.now,
  );
  call.attach(sink);
  return {
    call,
    sink,
    server,
    session,
    commands,
    env,
    turns,
    stored,
    loadHistory,
    reservations,
    reserve,
    finalize,
    refund,
    startCall,
    finishCall,
    prefetched,
    recordAnalytics,
    held: () => heldCall,
  };
}

export const START = {
  conversationId: 'conv-1',
  voice: 'female' as const,
  locale: 'es-ES',
  surfaceApplicationId: null,
};

/** Poll until `ready`, or throw naming what never happened. */
export async function until(label: string, ready: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** PCM16 of `ms` milliseconds at 24 kHz, as base64 for an `output_audio.delta`. */
export function pcmBase64(ms: number): string {
  return Buffer.alloc(ms * 48).toString('base64');
}
