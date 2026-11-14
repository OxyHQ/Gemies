/**
 * One voice call: Gemies between the person's socket and a Kaana `live`
 * session (ADR 0017 §3 as amended by ADR 0041).
 *
 *   socket ──audio──▶ VoiceCall ──appendAudio──▶ Kaana live session ──▶ voice
 *          ◀─audio + events── │ ◀──server events──┘
 *                             ├─ delegation.requested → one chat turn (`delegated-turn.ts`)
 *                             │    └─ its answer → delegation.reply, sentence by sentence
 *                             ├─ credits per minute (`credits.ts`)
 *                             └─ one call per person (`call-registry.ts`)
 *
 * The voice is a front end: it listens, decides when the person finished, and
 * speaks what it is given. Every turn it hands over is answered by the chat
 * route with the same gemie, tools, memory, model and credits as a typed turn,
 * and stored there. The voice holds only a persona and the recent
 * conversation (`persona.ts`).
 *
 * The device gets audio, transcripts and a few UI events; never an
 * instruction, a tool's arguments or its result.
 *
 * ## Opening, in the ADR's order
 *
 * Plan (`voice-mode`, enforced HERE, not only by the app) → the gemie → the
 * catalogue's default `live` line and its voice for the person's gender → the
 * first credit block → the one-call rule (this call takes over any other) →
 * the persona → Kaana. Another `live` line is tried only when the model itself
 * refused the open. The client stays `connecting` until Kaana's
 * `session.created` (→ `session.ready`).
 *
 * ## Turns
 *
 * `delegation.requested` carries the person's words since the last turn. They
 * become the person's message and the chat route's answer the gemie's, under
 * the ids every transcript and tool event of the turn names, so the device's
 * bubbles are the stored messages. `delegation.superseded` stops the turn the
 * way the app's Stop does; words the stop kept from being stored open the
 * next turn. A turn that fails is a typed failure: the voice is told so in
 * silent context and the delegation is dropped, never answered with filler.
 */

import { randomUUID } from 'node:crypto';
import type { RealtimeServerEvent } from '@kaana.ai/contracts';
import type { RealtimeClientEventInput, RealtimeSession } from '@kaana.ai/sdk';
import type { HydratedAgent } from '../agent-identity.js';
import { log } from '../logger.js';
import { liveVoiceLines, type LiveVoiceLine } from '../models/voice-models.js';
import type {
  CallState,
  CarriedWords,
  DelegationOutcome,
  DelegationState,
  UpstreamState,
} from './call-state.js';
import {
  END_REASON,
  sessionLimits,
  VOICE_CALL_LIMITS,
  type VoiceCallEnvironment,
  type VoiceCallLimits,
  type VoiceCallStart,
  type VoiceClientSink,
} from './call-contract.js';
import { VoiceCreditMeter } from './credits.js';
import { DelegatedTurnFailure, newTurnId } from './delegated-turn.js';
import {
  isModelRefusal,
  upstreamOfFailure,
  VOICE_ERROR_TEXT,
  VoiceFailure,
  voiceFailureFromKaana,
} from './errors.js';
import { voicePersona } from './persona.js';
import {
  encodeAssistantAudioFrame,
  MAX_CLIENT_AUDIO_FRAME_BYTES,
  type SequencedVoiceEvent,
  type VoiceCloseReason,
  type VoiceSessionEvent,
} from './protocol.js';
import { SentenceChunker, verbatimSpans } from './speech-chunks.js';

export {
  VOICE_CALL_LIMITS,
  type VoiceCallEnvironment,
  type VoiceCallLimits,
  type VoiceCallStart,
  type VoiceClientSink,
} from './call-contract.js';

/**
 * What a failed `close()` leaves Gemies to do: nothing. Kaana settles every
 * session it ends, including one closed here that it had already ended.
 */
function settledByKaana(): void {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/* -------------------------------------------------------------------------- */
/*  The call                                                                   */
/* -------------------------------------------------------------------------- */

export class VoiceCall {
  /** What a client resumes with. */
  readonly id = `vs_${randomUUID()}`;
  /** The `voice_calls` row. */
  readonly callId = `vc_${randomUUID()}`;

  private state: CallState = 'idle';
  private sink: VoiceClientSink | null = null;
  private seq = 0;
  private readonly replay: SequencedVoiceEvent[] = [];
  private accessToken: string;
  /** The verified app assertion of the call's socket, which the turns carry (ADR 0021). */
  private appAssertion: string | null = null;

  private start: VoiceCallStart | null = null;
  /** The call's gemie (Alia's when the start named none), set once the call starts. */
  private gemie: HydratedAgent | null = null;
  private line: LiveVoiceLine | null = null;
  private meter: VoiceCreditMeter | null = null;
  private registered = false;

  private upstream: UpstreamState | null = null;
  private pastUsd = 0;
  private servedModel: string | null = null;
  private servedEver = false;
  private openedAt: number | null = null;
  private reopens = 0;
  private inputAcknowledged = false;

  /** The turns the voice handed over that are still running, by delegation id. */
  private readonly delegations = new Map<string, DelegationState>();
  /** Settles when the latest turn has: the next one reads the conversation after it. */
  private lastTurn: Promise<unknown> = Promise.resolve();
  /** The person's words the voice has not handed over yet are stored under this id. */
  private pendingUserMessageId: string | null = null;
  /** Each input item's message, so a late transcript stays on the message it belongs to. */
  private readonly inputMessages = new Map<string, string>();
  /** What the voice says now belongs to this message: the latest turn's answer. */
  private speakingMessageId: string | null = null;
  private current: DelegationState | null = null;
  private carried: CarriedWords[] = [];
  private endAfterTurn = false;

  private durationTimer: NodeJS.Timeout | null = null;
  private warningTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private creditTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private ending: Promise<void> | null = null;
  private failure: VoiceFailure | null = null;
  private closeReason: VoiceCloseReason | null = null;
  private resolveEnded: () => void = () => undefined;
  /** Resolves once the call has fully ended (settled, told). */
  readonly ended = new Promise<void>((resolve) => {
    this.resolveEnded = resolve;
  });

  constructor(
    private readonly env: VoiceCallEnvironment,
    readonly oxyUserId: string,
    accessToken: string,
    private readonly limits: VoiceCallLimits = VOICE_CALL_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.accessToken = accessToken;
  }

  get isClosed(): boolean {
    return this.state === 'closing' || this.state === 'closed';
  }

  /**
   * Fresher credentials for the same person: the turns run with them from now
   * on. An `auth` without a verified assertion keeps the one the call has.
   */
  setAccessToken(token: string, appAssertion?: string | null): void {
    this.accessToken = token;
    if (appAssertion) this.appAssertion = appAssertion;
  }

  /* ------------------------------ the client ------------------------------ */

  /**
   * The socket is (back) here. With `afterSeq`, a resume: every event after it
   * is replayed, or `false` when they are no longer kept.
   */
  attach(sink: VoiceClientSink, afterSeq?: number): boolean {
    if (this.isClosed) return false;
    if (afterSeq !== undefined) {
      const oldest = this.replay[0]?.seq ?? this.seq;
      if (afterSeq + 1 < oldest) return false;
    }
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    const previous = this.sink;
    this.sink = sink;
    // A late close from the previous socket cannot detach the new holder.
    if (previous && previous !== sink) previous.close();
    if (afterSeq !== undefined) {
      for (const event of this.replay) if (event.seq > afterSeq) sink.sendEvent(event);
      this.emit({ type: 'session.resumed', afterSeq });
    }
    return true;
  }

  /** The socket went away without hanging up: keep the call for the resume window. */
  hasClient(sink: VoiceClientSink): boolean {
    return this.sink === sink && !this.isClosed;
  }

  detach(sink: VoiceClientSink): void {
    if (this.sink !== sink) return;
    this.sink = null;
    if (this.isClosed) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void this.end('error', new VoiceFailure('resume-unavailable'));
    }, this.limits.resumeWindowMs);
    this.graceTimer.unref?.();
  }

  private emit(event: VoiceSessionEvent): void {
    const sequenced = { ...event, seq: this.seq++ } as SequencedVoiceEvent;
    this.replay.push(sequenced);
    if (this.replay.length > this.limits.replayEvents) this.replay.shift();
    this.sink?.sendEvent(sequenced);
  }

  /** Microphone audio from the client. */
  onClientAudio(frame: Uint8Array): void {
    const upstream = this.upstream;
    if (this.state !== 'live' || !upstream || upstream.createdAt === null) return;
    if (frame.byteLength === 0 || frame.byteLength > MAX_CLIENT_AUDIO_FRAME_BYTES) return;
    try {
      upstream.session.appendAudio(frame);
    } catch (error) {
      log.voice.warn({ err: error, callId: this.callId }, 'Audio not appended upstream');
      return;
    }
    if (!this.inputAcknowledged) {
      this.inputAcknowledged = true;
      this.emit({ type: 'input.ready' });
    }
  }

  /* -------------------------------- opening ------------------------------- */

  async open(start: VoiceCallStart): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'opening';
    this.start = start;
    this.emit({ type: 'session.accepted', voiceSessionId: this.id, callId: this.callId });
    try {
      // A group's turns are its members'; a call has one gemie and cannot speak for them.
      if ((await this.env.groupMembers(this.oxyUserId, start.conversationId)).length > 0)
        throw new VoiceFailure('agent-unavailable');
      const inputs = await this.env.prefetch({
        oxyUserId: this.oxyUserId,
        accessToken: this.accessToken,
        isDirectUserSession: true,
        ...(start.agentId === undefined ? {} : { requestedAgentId: start.agentId }),
        surfaceApplicationId: start.surfaceApplicationId,
      });
      // `voice-mode` is enforced by the server, not only by the app.
      if (inputs.entitlements === null)
        throw new VoiceFailure('realtime-unavailable', { retryable: true });
      if (!inputs.entitlements.features['voice-mode']) {
        // The one refusal the person is told to pay for: which account and plan
        // decided it is what makes a wrong one traceable.
        log.voice.warn(
          { callId: this.callId, oxyUserId: this.oxyUserId, planId: inputs.entitlements.planId },
          'Voice call refused: the plan has no voice mode',
        );
        throw new VoiceFailure('plan-required');
      }

      const agent = inputs.turnAgent;
      if (agent.kind !== 'agent') {
        throw new VoiceFailure(
          agent.kind === 'resolution_unavailable' || agent.kind === 'identity_unavailable'
            ? 'realtime-unavailable'
            : 'agent-unavailable',
          { retryable: agent.kind !== 'unavailable' },
        );
      }
      const gemie = agent.agent;
      this.gemie = gemie;

      const kaana = this.env.kaana;
      if (!kaana) throw new VoiceFailure('realtime-unavailable');
      const models = await kaana.models
        .list({ onBehalfOfUserId: this.oxyUserId })
        .catch((error: unknown) => {
          throw voiceFailureFromKaana(error);
        });
      // The catalogue's default first; the others only on the model's own refusal (ADR 0041 §1).
      const lines = liveVoiceLines(models, start);
      if (lines.length === 0) throw new VoiceFailure('realtime-unavailable');

      this.meter = new VoiceCreditMeter(this.oxyUserId, this.env.credits);
      if (!(await this.meter.open(lines[0]!.usdPerMinute)))
        throw new VoiceFailure('credits-exhausted');
      if (this.isClosed) return;

      await this.env.startCall({
        callId: this.callId,
        oxyUserId: this.oxyUserId,
        conversationId: start.conversationId,
        agentId: gemie._id,
        call: { takenOver: () => this.end('call-moved-elsewhere') },
      });
      this.registered = true;
      if (this.isClosed) {
        // Hung up while the row was being written: the ending may have run
        // before it existed, so it is ended here (a second end is a no-op).
        await this.env.finishCall(this.callId, END_REASON[this.closeReason ?? 'hangup']);
        return;
      }
      await this.connect(lines);
    } catch (error) {
      await this.end('error', error instanceof VoiceFailure ? error : voiceFailureFromKaana(error));
    }
  }

  private command(body: RealtimeClientEventInput): void {
    const upstream = this.upstream;
    if (!upstream || upstream.requestId === null) return;
    try {
      upstream.session.send(body);
    } catch (error) {
      log.voice.warn(
        { err: error, type: body.type, callId: this.callId },
        'Command not sent upstream',
      );
    }
  }

  /** Open the upstream `live` session on the first line that does not refuse it. */
  private async connect(lines: readonly LiveVoiceLine[]): Promise<void> {
    const kaana = this.env.kaana;
    const start = this.start;
    const gemie = this.gemie;
    if (!kaana || !start || !gemie) throw new VoiceFailure('realtime-unavailable');
    const history = await this.env.loadHistory(this.oxyUserId, start.conversationId);
    const instructions = voicePersona({ gemie, language: start.locale, history });
    const elapsed = this.openedAt === null ? 0 : this.now() - this.openedAt;
    const remaining = Math.max(1_000, this.limits.maxDurationMs - elapsed);

    let session: RealtimeSession | null = null;
    for (const [index, line] of lines.entries()) {
      try {
        session = await kaana.realtime.connect(
          {
            model: line.model.modelId,
            type: 'session.open',
            kind: 'live',
            transport: 'websocket',
            config: {
              instructions,
              voice: line.voiceId,
              inputAudioFormat: 'pcm16_24khz',
              outputAudioFormat: 'pcm16_24khz',
              // The voice decides when the person finished and when it may be interrupted.
              turnDetection: { type: 'server_vad', createResponse: true, interruptResponse: true },
              // The person's words, transcribed in their own BCP 47 locale.
              inputAudioTranscription: { language: start.locale },
              // A short "one moment" while the turn is answered.
              delegation: { acknowledgement: 'auto' },
            },
            limits: sessionLimits(remaining, this.limits.idleTimeoutMs),
            clientSessionId: this.callId,
            labels: { surface: 'alia-voice' },
          },
          { onBehalfOfUserId: this.oxyUserId },
        );
        this.line = line;
        break;
      } catch (error) {
        if (index < lines.length - 1 && isModelRefusal(error)) {
          log.voice.warn(
            { model: line.model.modelId, callId: this.callId },
            'Live model refused the call; trying the next line',
          );
          continue;
        }
        throw voiceFailureFromKaana(error);
      }
    }
    if (!session || !this.line) throw new VoiceFailure('realtime-unavailable');
    this.meter?.reprice(this.line.usdPerMinute);
    if (this.isClosed) {
      await session.close().catch(settledByKaana);
      return;
    }
    const upstream: UpstreamState = {
      session,
      requestId: null,
      createdAt: null,
      endedAt: null,
    };
    this.upstream = upstream;
    this.inputAcknowledged = false;
    void this.pump(upstream);
  }

  /* -------------------------------- upstream ------------------------------ */

  private async pump(upstream: UpstreamState): Promise<void> {
    try {
      for await (const event of upstream.session) {
        if (this.upstream !== upstream) {
          if (event.type === 'session.closed') upstream.endedAt ??= this.now();
          continue;
        }
        this.handle(event);
        if (event.type === 'session.closed') return;
      }
    } catch (error) {
      if (this.isClosed || this.upstream !== upstream) return;
      log.voice.warn({ err: error, callId: this.callId }, 'Upstream session lost; resuming');
      await this.recover(upstream);
    }
  }

  /** Gemies ↔ Kaana dropped: resume within Kaana's window, else a new session under the same call. */
  private async recover(upstream: UpstreamState): Promise<void> {
    this.state = 'reconnecting';
    this.emit({ type: 'session.reconnecting' });
    try {
      await upstream.session.resume();
      if (this.isClosed) return;
      this.state = 'live';
      void this.pump(upstream);
      return;
    } catch {
      await this.reopen();
    }
  }

  private async reopen(): Promise<void> {
    if (this.isClosed) return;
    this.reopens += 1;
    if (this.reopens > this.limits.maxReopens || !this.line || !this.start) {
      await this.end('error', new VoiceFailure('realtime-failed', { retryable: true }));
      return;
    }
    this.state = 'reconnecting';
    this.emit({ type: 'session.reconnecting' });
    const previous = this.upstream;
    if (previous) {
      previous.endedAt ??= this.now();
      this.pastUsd += this.usdOf(previous);
      this.upstream = null;
      void previous.session.close().catch(settledByKaana);
    }
    // The old session's delegations died with it; what was stored is in the new persona.
    for (const delegation of this.delegations.values()) this.stopTurn(delegation, 'superseded');
    await Promise.race([this.lastTurn, sleep(this.limits.settleWaitMs)]);
    try {
      await this.connect([this.line]);
    } catch (error) {
      await this.end('error', error instanceof VoiceFailure ? error : voiceFailureFromKaana(error));
    }
  }

  private handle(event: RealtimeServerEvent): void {
    if (event.type === 'session.closed') {
      if (this.upstream) this.upstream.endedAt ??= this.now();
      this.onUpstreamClosed(event.reason);
      return;
    }
    if (this.isClosed) return;
    switch (event.type) {
      case 'session.created':
        this.onCreated(event);
        return;
      case 'input_audio.speech_started':
        this.activity();
        this.emit({ type: 'user.speech_started', itemId: event.itemId });
        return;
      case 'input_audio.speech_stopped':
        this.activity();
        this.emit({ type: 'user.speech_stopped', itemId: event.itemId });
        return;
      case 'transcript.delta':
      case 'transcript.done': {
        this.activity();
        const text = event.type === 'transcript.delta' ? event.text : event.transcript;
        if (event.source === 'input_audio') {
          this.emit({
            type: event.type,
            role: 'user',
            messageId: this.userMessageOf(event.itemId),
            itemId: event.itemId,
            text,
          });
          return;
        }
        this.speakingMessageId ??= `voice-${randomUUID()}`;
        if (this.current) this.current.lastAudioItem = event.itemId;
        this.emit({
          type: event.type,
          role: 'assistant',
          messageId: this.speakingMessageId,
          itemId: event.itemId,
          text,
        });
        return;
      }
      case 'output_audio.delta': {
        this.activity();
        if (this.current) this.current.lastAudioItem = event.itemId;
        const pcm = Buffer.from(event.data, 'base64');
        try {
          this.sink?.sendAudio(encodeAssistantAudioFrame(event.itemId, pcm));
        } catch (error) {
          log.voice.warn({ err: error, callId: this.callId }, 'Assistant audio not framed');
        }
        return;
      }
      case 'delegation.requested':
        this.activity();
        this.delegate(event.delegationId, event.text);
        return;
      case 'delegation.superseded': {
        const delegation = this.delegations.get(event.delegationId);
        if (delegation) this.stopTurn(delegation, 'superseded');
        return;
      }
      case 'error':
        if (event.fatal) void this.end('error', voiceFailureFromKaana(event.error));
        else
          log.voice.warn(
            { code: event.error.code, param: event.error.param, callId: this.callId },
            'Upstream refused a command; the call goes on',
          );
        return;
      default:
        return;
    }
  }

  private onCreated(event: Extract<RealtimeServerEvent, { type: 'session.created' }>): void {
    const upstream = this.upstream;
    if (!upstream) return;
    const firstCreated = upstream.requestId === null;
    upstream.requestId = event.requestId;
    if (firstCreated) {
      log.voice.info(
        { callId: this.callId, kaanaRequestId: event.requestId },
        'Voice upstream session created',
      );
    }
    upstream.createdAt = this.now();
    this.servedModel = event.model;
    this.servedEver = true;
    const first = this.openedAt === null;
    if (first) this.openedAt = this.now();
    this.state = 'live';
    const line = this.line;
    const elapsed = this.now() - (this.openedAt ?? this.now());
    this.emit({
      type: 'session.ready',
      model: {
        id: event.model,
        displayName: line?.model.displayName ?? event.model,
        publisher: line?.model.publisher.displayName ?? '',
      },
      maxDurationMs: Math.max(0, this.limits.maxDurationMs - elapsed),
      idleTimeoutMs: this.limits.idleTimeoutMs,
      resumeWindowMs: this.limits.resumeWindowMs,
    });
    if (first) this.startTimers();
    this.activity();
  }

  private onUpstreamClosed(
    reason: Extract<RealtimeServerEvent, { type: 'session.closed' }>['reason'],
  ): void {
    if (this.isClosed) return;
    switch (reason) {
      case 'client_closed':
        return;
      case 'server_shutdown':
        // Resume is per Kaana task; a task going away needs a new session.
        void this.reopen();
        return;
      case 'max_duration':
        void this.end('max-duration');
        return;
      case 'idle_timeout':
        void this.end('idle-timeout');
        return;
      case 'no_route_available':
        void this.end('error', new VoiceFailure('realtime-unavailable', { retryable: true }));
        return;
      case 'limit_exceeded':
        void this.end('error', new VoiceFailure('realtime-limited'));
        return;
      default:
        void this.end('error', new VoiceFailure('realtime-failed', { retryable: true }));
    }
  }

  /* --------------------------------- turns -------------------------------- */

  /** The message an input item's words belong to: the turn the voice has not handed over yet. */
  private userMessageOf(itemId: string): string {
    const known = this.inputMessages.get(itemId);
    if (known) return known;
    this.pendingUserMessageId ??= `voice-${randomUUID()}`;
    this.inputMessages.set(itemId, this.pendingUserMessageId);
    return this.pendingUserMessageId;
  }

  /** One `delegation.requested`: one chat turn, started now, answered as it streams. */
  private delegate(delegationId: string, text: string): void {
    if (this.delegations.has(delegationId)) return;
    const delegation: DelegationState = {
      delegationId,
      turnId: newTurnId(),
      userMessageId: this.pendingUserMessageId ?? `voice-${randomUUID()}`,
      assistantMessageId: `voice-${randomUUID()}`,
      controller: new AbortController(),
      superseded: false,
      lastAudioItem: null,
    };
    // Later words open the next message; what the voice says now is this answer.
    this.pendingUserMessageId = null;
    this.speakingMessageId = delegation.assistantMessageId;
    this.current = delegation;
    this.delegations.set(delegationId, delegation);
    const previous = this.lastTurn;
    const answered = this.answer(delegation, text, previous);
    this.lastTurn = answered;
    void answered.then((outcome) => this.afterTurn(delegation, outcome));
  }

  /** Stop a running turn: superseded (the app's Stop), or because the call no longer needs it. */
  private stopTurn(delegation: DelegationState, why: 'superseded' | 'call-ended'): void {
    if (delegation.controller.signal.aborted) return;
    delegation.superseded = true;
    delegation.controller.abort();
    // A hung-up call leaves its last answer to finish and be stored, as a typed turn does.
    if (why === 'call-ended' || !this.start) return;
    void this.env.turns
      .cancel({
        accessToken: this.accessToken,
        appAssertion: this.appAssertion,
        turnId: delegation.turnId,
        conversationId: this.start.conversationId,
      })
      .catch((error: unknown) =>
        log.voice.warn({ err: error, callId: this.callId }, 'Superseded turn not cancelled'),
      );
  }

  private reply(delegation: DelegationState, text: string, final: boolean): void {
    if (delegation.superseded || this.isClosed) return;
    const verbatim = verbatimSpans(text);
    this.command({
      type: 'delegation.reply',
      delegationId: delegation.delegationId,
      text,
      ...(verbatim.length > 0 ? { verbatim } : {}),
      final,
    });
  }

  /** Answer one delegation through the chat route, streaming each sentence to the voice. */
  private async answer(
    delegation: DelegationState,
    text: string,
    previous: Promise<unknown>,
  ): Promise<DelegationOutcome> {
    const start = this.start;
    if (!start) return 'dropped';
    const { signal } = delegation.controller;
    // The turn it superseded settles first, so the history sent is the history stored.
    await Promise.race([previous, sleep(this.limits.settleWaitMs)]);
    const words = text.trim();
    let history: Awaited<ReturnType<VoiceCallEnvironment['loadHistory']>>;
    try {
      history = await this.env.loadHistory(this.oxyUserId, start.conversationId);
    } catch (error) {
      log.voice.warn({ err: error, callId: this.callId }, 'Conversation not read for a turn');
      this.dropDelegation(delegation, 'failed');
      return 'failed';
    }
    const stored = new Set(history.map((message) => message.id));
    const carried = this.carried.filter((entry) => !stored.has(entry.messageId));
    this.carried = [];
    const said = [...carried.map((entry) => entry.text), words].filter(Boolean).join(' ');
    if (signal.aborted) {
      if (said !== '') this.carried = [{ messageId: delegation.userMessageId, text: said }];
      return 'superseded';
    }
    if (said === '') {
      this.dropDelegation(delegation, 'dropped');
      return 'dropped';
    }

    const chunker = new SentenceChunker();
    const { assistantMessageId } = delegation;
    try {
      const events = this.env.turns.run({
        accessToken: this.accessToken,
        appAssertion: this.appAssertion,
        conversationId: start.conversationId,
        ...(start.agentId === undefined ? {} : { agentId: start.agentId }),
        messages: [...history, { id: delegation.userMessageId, role: 'user', content: said }],
        assistantMessageId,
        turnId: delegation.turnId,
        signal,
      });
      for await (const event of events) {
        this.activity();
        if (event.type === 'text') {
          for (const sentence of chunker.push(event.text)) this.reply(delegation, sentence, false);
        } else if (event.type === 'tool.started') {
          this.emit({
            type: 'tool.started',
            messageId: assistantMessageId,
            callId: event.callId,
            name: event.name,
          });
          if (!delegation.superseded)
            this.command({
              type: 'delegation.context',
              delegationId: delegation.delegationId,
              text: `Still working on it: running ${event.name}.`,
            });
        } else {
          this.emit({
            type: 'tool.finished',
            messageId: assistantMessageId,
            callId: event.callId,
            name: event.name,
            ok: event.ok,
          });
        }
      }
      const tail = chunker.end();
      if (tail.length === 0) {
        this.dropDelegation(delegation, 'answered');
      } else {
        for (const [index, part] of tail.entries())
          this.reply(delegation, part, index === tail.length - 1);
        this.emit({
          type: 'assistant.done',
          itemId: delegation.lastAudioItem,
          status: 'completed',
        });
      }
      // The chat route stored both before it ended the stream.
      this.emit({
        type: 'messages.saved',
        conversationId: start.conversationId,
        messageIds: [delegation.userMessageId, assistantMessageId],
      });
      return 'answered';
    } catch (error) {
      if (signal.aborted) {
        // Stopped before the chat route stored it: the words open the next turn.
        this.carried = [{ messageId: delegation.userMessageId, text: said }];
        this.emit({
          type: 'assistant.done',
          itemId: delegation.lastAudioItem,
          status: 'cancelled',
        });
        return 'superseded';
      }
      log.voice.warn(
        {
          err: error instanceof DelegatedTurnFailure ? undefined : error,
          code: error instanceof DelegatedTurnFailure ? error.code : undefined,
          callId: this.callId,
          turnId: delegation.turnId,
        },
        'Delegated turn failed',
      );
      this.dropDelegation(delegation, 'failed');
      return 'failed';
    }
  }

  /**
   * End a delegation that gets no (more) spoken answer. A failed one tells the
   * voice in silent context first, so it can say so in its own words: the
   * failure is never dressed up as an answer.
   */
  private dropDelegation(delegation: DelegationState, outcome: 'answered' | 'failed' | 'dropped') {
    if (!delegation.superseded && outcome === 'failed')
      this.command({
        type: 'delegation.context',
        delegationId: delegation.delegationId,
        text: 'This request could not be answered. Tell the person briefly, and that they can ask again.',
      });
    if (!delegation.superseded)
      this.command({ type: 'delegation.cancel', delegationId: delegation.delegationId });
    this.emit({
      type: 'assistant.done',
      itemId: delegation.lastAudioItem,
      status: outcome === 'failed' ? 'failed' : 'completed',
    });
  }

  private afterTurn(delegation: DelegationState, outcome: DelegationOutcome): void {
    this.delegations.delete(delegation.delegationId);
    if (this.current === delegation) this.current = null;
    log.voice.info(
      { callId: this.callId, turnId: delegation.turnId, outcome },
      'Delegated turn settled',
    );
    void this.checkCredits();
    if (this.endAfterTurn && this.delegations.size === 0 && !this.isClosed)
      void this.end('credits-exhausted', new VoiceFailure('credits-exhausted'));
  }

  /* --------------------------- timers and credits -------------------------- */

  private startTimers(): void {
    const { maxDurationMs, warningBeforeMs, creditCheckMs } = this.limits;
    this.durationTimer = setTimeout(() => void this.end('max-duration'), maxDurationMs);
    if (maxDurationMs > warningBeforeMs)
      this.warningTimer = setTimeout(
        () =>
          this.emit({ type: 'session.warning', code: 'ending-soon', remainingMs: warningBeforeMs }),
        maxDurationMs - warningBeforeMs,
      );
    this.creditTimer = setInterval(() => void this.checkCredits(), creditCheckMs);
    for (const timer of [this.durationTimer, this.warningTimer, this.creditTimer]) timer?.unref?.();
  }

  private activity(): void {
    if (this.isClosed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.end('idle-timeout'), this.limits.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /**
   * What an upstream session has cost so far, in USD: its minutes, silence
   * included, at the line's published price per minute. The turns are typed
   * turns, each charged by the chat route.
   */
  private usdOf(upstream: UpstreamState): number {
    const perMinute = this.line?.usdPerMinute ?? null;
    if (perMinute === null || upstream.createdAt === null) return 0;
    const minutes = ((upstream.endedAt ?? this.now()) - upstream.createdAt) / 60_000;
    return Math.max(0, minutes) * perMinute;
  }

  private runningUsd(): number {
    return this.pastUsd + (this.upstream ? this.usdOf(this.upstream) : 0);
  }

  private async checkCredits(): Promise<void> {
    if (this.state !== 'live' || !this.meter) return;
    const covered = await this.meter.cover(this.runningUsd());
    if (covered || this.isClosed) return;
    // Never mid-answer: the turn being answered finishes first.
    if (this.delegations.size > 0) {
      this.endAfterTurn = true;
      return;
    }
    await this.end('credits-exhausted', new VoiceFailure('credits-exhausted'));
  }

  /* --------------------------------- ending -------------------------------- */

  /** End the call once, for one reason; every path ends here. */
  end(reason: VoiceCloseReason, failure?: VoiceFailure): Promise<void> {
    if (this.ending) return this.ending;
    this.state = 'closing';
    this.closeReason = reason;
    this.failure = failure ?? null;
    this.ending = (async () => {
      for (const timer of [this.durationTimer, this.warningTimer, this.idleTimer, this.graceTimer])
        if (timer) clearTimeout(timer);
      if (this.creditTimer) clearInterval(this.creditTimer);
      for (const delegation of this.delegations.values()) this.stopTurn(delegation, 'call-ended');

      if (failure) {
        log.voice.warn(
          { code: failure.code, reason, callId: this.callId, upstream: upstreamOfFailure(failure) },
          'Voice call failed',
        );
        this.emit({
          type: 'error',
          code: failure.code,
          message: VOICE_ERROR_TEXT[failure.code],
          retryable: failure.retryable,
          reference: this.callId,
        });
      }

      const upstream = this.upstream;
      if (upstream) {
        upstream.endedAt ??= this.now();
        // Settles exactly once upstream; bounded so a hung close never holds the call.
        await Promise.race([upstream.session.close().catch(settledByKaana), sleep(5_000)]);
      }

      if (this.meter) {
        if (this.servedEver) {
          const usd = this.pastUsd + (upstream ? this.usdOf(upstream) : 0);
          await this.meter.settle(usd);
        } else {
          await this.meter.release();
        }
      }
      if (this.registered && reason !== 'call-moved-elsewhere')
        await this.env.finishCall(this.callId, END_REASON[reason]);

      this.emit({ type: 'session.closed', reason });
      this.state = 'closed';
      this.sink?.close();
      this.sink = null;

      if (this.servedEver && this.start && this.servedModel) {
        await this.env
          .recordAnalytics({
            oxyUserId: this.oxyUserId,
            conversationId: this.start.conversationId,
            model: this.servedModel.split('@')[0]!,
            resolvedModelReference: this.servedModel,
            latencyMs: this.openedAt === null ? 0 : this.now() - this.openedAt,
            errorClass: this.failure?.code ?? null,
          })
          .catch((error: unknown) =>
            log.voice.warn({ err: error }, 'Voice analytics not recorded'),
          );
      }
      log.voice.info(
        { callId: this.callId, reason, model: this.servedModel, reopens: this.reopens },
        'Voice call ended',
      );
      this.resolveEnded();
    })().finally(() => this.env.kaana?.dispose?.());
    return this.ending;
  }
}
