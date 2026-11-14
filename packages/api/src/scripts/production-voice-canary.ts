/**
 * Production canary of voice mode (ADR 0041 §7): one real call on Kaana's
 * default `live` line, answered by the chat route, as the QA account.
 *
 * It runs inside the live API image as an ECS one-shot (the workflow
 * `production-voice-canary.yml`), like the chat canary: it starts that image's
 * API and enters its loopback `/alia/chat` with Alia's shared SDK workload
 * transport and the QA account's live Oxy automation task, so the ordinary Oxy
 * middleware validates the workload, the requester and the task before any
 * turn runs. There is no canary-only authentication exception.
 *
 * The call is the production `VoiceCall` with the production environment
 * (`createVoiceEnvironment`): the plan check, the gemie, the catalogue's
 * default line and voice, the credit meter, the one-call registry, the persona
 * and the Kaana `live` session through Alia's Kaana transport. It enters one
 * layer below the voice socket, whose `auth` admits only a person's own Oxy
 * session — a bearer the runbook forbids persisting for the QA account — and
 * whose handshake `voice-socket.test.ts` covers. Everything the socket hands a
 * call, the canary hands it: microphone frames in real time, and a sink for
 * what the device would receive.
 *
 * It streams a recorded request for a reminder (`fixtures/voice-canary-reminder.pcm`,
 * 24 kHz PCM16 mono, synthesized offline), then silence, until the answer has
 * been spoken; hangs up; stops the reminder the way the product's DELETE does
 * and removes the canary's conversation. It passes when:
 *
 * - the call opened on a `live` line and audio came back after the answer;
 * - exactly one turn was answered and stored, and it called `createAutomation`
 *   successfully;
 * - the call settled: Kaana's session close returned its usage, the minutes
 *   were charged, the `voice_calls` row ended `hangup`, and the reminder was
 *   stopped.
 *
 * It refuses to run unless ALIA_CANARY_OXY_USER_ID and ALIA_CANARY_OXY_TASK_ID
 * name the QA identity and ALIA_VOICE_CANARY_CONFIRM is
 * `production-voice-canary`. It never prints the QA identity, a credential, the
 * prompt or the answer; the one result line is `ALIA_VOICE_CANARY {json}`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RealtimeServerEvent } from '@kaana.ai/contracts';
import type { RealtimeSession } from '@kaana.ai/sdk';
import type { KaanaClient } from '../lib/kaana/port.js';
import type { VoiceCallEnvironment, VoiceClientSink } from '../lib/voice/call.js';
import type { VoiceCreditDeps } from '../lib/voice/credits.js';
import type { VoiceTurnRunner } from '../lib/voice/delegated-turn.js';
import type { SequencedVoiceEvent } from '../lib/voice/protocol.js';

const CONFIRM_VALUE = 'production-voice-canary';
const RESULT_MARKER = 'ALIA_VOICE_CANARY';
const API_BASE_URL = 'http://127.0.0.1:3001';
/** The tool a reminder is made with (`lib/tools/automation-create.ts`). */
const REMINDER_TOOL = 'createAutomation';

const SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const FRAME_MS = 40;
/** How long the answer's audio must have stopped before the canary hangs up. */
const QUIET_AFTER_ANSWER_MS = 3_000;
const CALL_TIMEOUT_MS = 120_000;

/** The recorded request, shipped beside the bundle (`build.ts` copies it to `dist/scripts/fixtures`). */
export const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'voice-canary-reminder.pcm',
);

export interface VoiceCanaryReport {
  callId: string;
  /** Kaana's id of the `live` session, and its request id from `session.created`. */
  kaanaSessionId: string | null;
  kaanaRequestId: string | null;
  /** The line that served the call (`publisher/model@revision`). */
  model: string | null;
  audioMs: number;
  /** Turns the voice handed over, as the chat route was asked for them. */
  delegatedTurns: number;
  /** Turns answered and stored (`messages.saved`). */
  answeredTurns: number;
  tools: Array<{ name: string; ok: boolean }>;
  /** Voice audio received at all, and after the answer was stored. */
  audioBytes: number;
  answerAudioBytes: number;
  closedReason: string | null;
  errors: string[];
  /** Kaana's usage of the session, as its close resolved (what Oxy settles). */
  kaanaUnits: Array<{ unit: string; quantity: number }> | null;
  /** The credits the call's minutes were charged, block by block. */
  creditsCharged: number | null;
  callRowEnd: string | null;
  reminderStopped: boolean;
  wallMs: number;
}

/** Every reason the report fails; empty means the canary passed. */
export function judge(report: VoiceCanaryReport): string[] {
  const failures: string[] = [];
  if (report.model === null) failures.push('no live session was created');
  if (report.errors.length > 0) failures.push(`call errors: ${report.errors.join(', ')}`);
  if (report.delegatedTurns < 1) failures.push('the voice handed over no turn');
  if (report.answeredTurns !== 1)
    failures.push(`${report.answeredTurns} turns answered and stored, not exactly one`);
  if (!report.tools.some((tool) => tool.name === REMINDER_TOOL && tool.ok))
    failures.push(`the answered turn did not call ${REMINDER_TOOL} successfully`);
  if (report.audioBytes === 0) failures.push('no audio came back');
  if (report.answerAudioBytes === 0) failures.push('the answer was not spoken');
  if (report.closedReason !== 'hangup') failures.push(`closed ${report.closedReason ?? 'never'}`);
  if (report.kaanaUnits === null) failures.push("Kaana's session close returned no usage");
  if (report.creditsCharged === null || report.creditsCharged <= 0)
    failures.push('the call minutes were not charged');
  if (report.callRowEnd !== 'hangup')
    failures.push(`voice_calls row ${report.callRowEnd ?? 'open'}`);
  if (!report.reminderStopped) failures.push('the reminder was not stopped');
  return failures;
}

/** What the canary watches of the call's world: the same environment, observed. */
interface Observed {
  sessionId: string | null;
  requestId: string | null;
  units: Array<{ unit: string; quantity: number }> | null;
  credits: number | null;
  callRowEnd: string | null;
  delegatedTurns: number;
}

function observedSession(session: RealtimeSession, seen: Observed): RealtimeSession {
  seen.sessionId = session.sessionId;
  return {
    get sessionId() {
      return session.sessionId;
    },
    send: (event) => session.send(event),
    appendAudio: (pcm) => session.appendAudio(pcm),
    resume: () => session.resume(),
    close: async () => {
      const units = await session.close();
      seen.units = units.map(({ unit, quantity }) => ({ unit, quantity }));
      return units;
    },
    async *[Symbol.asyncIterator]() {
      for await (const event of session as AsyncIterable<RealtimeServerEvent>) {
        if (event.type === 'session.created') seen.requestId = event.requestId;
        yield event;
      }
    },
  };
}

/** The environment with each settlement it makes, and each turn it runs, written down. */
export function observe(env: VoiceCallEnvironment & { readonly credits: VoiceCreditDeps }): {
  env: VoiceCallEnvironment;
  seen: Observed;
} {
  const seen: Observed = {
    sessionId: null,
    requestId: null,
    units: null,
    credits: null,
    callRowEnd: null,
    delegatedTurns: 0,
  };
  const kaana: KaanaClient | null = env.kaana && {
    ...env.kaana,
    realtime: {
      connect: (async (request, options) =>
        observedSession(
          await env.kaana!.realtime.connect(request, options),
          seen,
        )) as KaanaClient['realtime']['connect'],
    },
  };
  const turns: VoiceTurnRunner = {
    run: (request) => {
      seen.delegatedTurns += 1;
      return env.turns.run(request);
    },
    cancel: (turn) => env.turns.cancel(turn),
  };
  return {
    seen,
    env: {
      ...env,
      kaana,
      turns,
      credits: {
        ...env.credits,
        finalize: async (reservation, credits) => {
          seen.credits = (seen.credits ?? 0) + credits;
          return env.credits.finalize(reservation, credits);
        },
      },
      finishCall: async (callId, reason) => {
        seen.callRowEnd = reason;
        await env.finishCall(callId, reason);
      },
    },
  };
}

/** What the device would have received. */
class CanarySink implements VoiceClientSink {
  readonly events: SequencedVoiceEvent[] = [];
  audioBytes = 0;
  answerAudioBytes = 0;
  lastAudioAt = 0;
  constructor(private readonly now: () => number) {}
  sendEvent(event: SequencedVoiceEvent): void {
    this.events.push(event);
  }
  sendAudio(frame: Uint8Array): void {
    const pcm = frame.byteLength - 1 - (frame[0] ?? 0);
    this.audioBytes += pcm;
    if (this.saved()) this.answerAudioBytes += pcm;
    this.lastAudioAt = this.now();
  }
  close(): void {}
  saved(): boolean {
    return this.events.some((event) => event.type === 'messages.saved');
  }
  find<T extends SequencedVoiceEvent['type']>(type: T) {
    return this.events.filter((event) => event.type === type) as Array<
      Extract<SequencedVoiceEvent, { type: T }>
    >;
  }
}

export interface RunDependencies {
  /** The call's environment; the canary observes it. */
  readonly env: VoiceCallEnvironment & { readonly credits: VoiceCreditDeps };
  /** Builds the call (`VoiceCall`), so tests can pass its limits. */
  readonly newCall: (env: VoiceCallEnvironment) => import('../lib/voice/call.js').VoiceCall;
  /** Stops the reminder the answered turn created; whether it found and stopped one. */
  readonly stopReminder: (conversationId: string) => Promise<boolean>;
  readonly removeConversation: (conversationId: string) => Promise<void>;
  /** Real time by default; tests pass 0. */
  readonly frameDelayMs?: number;
  readonly quietAfterAnswerMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Call, speak, wait for the spoken answer, hang up, clean up, and report. */
export async function runVoiceCanary(
  pcm: Uint8Array,
  deps: RunDependencies,
): Promise<VoiceCanaryReport> {
  const now = deps.now ?? Date.now;
  const frameDelayMs = deps.frameDelayMs ?? FRAME_MS;
  const quietMs = deps.quietAfterAnswerMs ?? QUIET_AFTER_ANSWER_MS;
  const startedAt = now();
  const deadline = startedAt + (deps.timeoutMs ?? CALL_TIMEOUT_MS);
  const { env, seen } = observe(deps.env);
  const call = deps.newCall(env);
  const sink = new CanarySink(now);
  call.attach(sink);
  const conversationId = randomUUID();
  const opening = call.open({
    conversationId,
    voice: 'female',
    locale: 'en-US',
    surfaceApplicationId: null,
  });

  const ready = () => sink.events.some((event) => event.type === 'session.ready');
  while (!ready() && !call.isClosed && now() < deadline) await sleep(20);
  await Promise.race([opening, sleep(0)]);

  if (ready()) {
    const frameBytes = FRAME_MS * BYTES_PER_MS;
    const silence = new Uint8Array(frameBytes);
    // The request in real time, then silence: the voice decides when the person finished.
    for (let offset = 0; offset < pcm.byteLength && !call.isClosed; offset += frameBytes) {
      call.onClientAudio(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength)));
      await sleep(frameDelayMs);
    }
    while (!call.isClosed && now() < deadline) {
      if (sink.saved() && sink.answerAudioBytes > 0 && now() - sink.lastAudioAt >= quietMs) break;
      call.onClientAudio(silence);
      await sleep(Math.max(frameDelayMs, 1));
    }
  }
  await call.end('hangup');
  await call.ended;

  let reminderStopped = false;
  try {
    reminderStopped = await deps.stopReminder(conversationId);
  } finally {
    await deps.removeConversation(conversationId).catch(() => undefined);
  }

  const savedIds = new Set(sink.find('messages.saved').flatMap((event) => event.messageIds));
  return {
    callId: call.callId,
    kaanaSessionId: seen.sessionId,
    kaanaRequestId: seen.requestId,
    model: sink.find('session.ready')[0]?.model.id ?? null,
    audioMs: Math.floor(pcm.byteLength / BYTES_PER_MS),
    delegatedTurns: seen.delegatedTurns,
    answeredTurns: sink.find('messages.saved').length,
    tools: sink
      .find('tool.finished')
      .filter((event) => savedIds.has(event.messageId))
      .map((event) => ({ name: event.name, ok: event.ok })),
    audioBytes: sink.audioBytes,
    answerAudioBytes: sink.answerAudioBytes,
    closedReason: sink.find('session.closed')[0]?.reason ?? null,
    errors: sink.find('error').map((event) => event.code),
    kaanaUnits: seen.units,
    creditsCharged: seen.credits,
    callRowEnd: seen.callRowEnd,
    reminderStopped,
    wallMs: now() - startedAt,
  };
}

/** The QA identity and the explicit confirmation, or a refusal naming what is missing. */
export function canaryIdentity(env: NodeJS.ProcessEnv): { accountId: string; taskId: string } {
  if (env.ALIA_VOICE_CANARY_CONFIRM !== CONFIRM_VALUE)
    throw new Error(`ALIA_VOICE_CANARY_CONFIRM must be ${CONFIRM_VALUE}`);
  const accountId = env.ALIA_CANARY_OXY_USER_ID;
  const taskId = env.ALIA_CANARY_OXY_TASK_ID;
  if (
    !accountId ||
    !/^(?:[a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      accountId,
    )
  )
    throw new Error('ALIA_CANARY_OXY_USER_ID must name one exact QA account');
  if (!taskId || taskId.length > 128 || /\s/.test(taskId))
    throw new Error('ALIA_CANARY_OXY_TASK_ID must name its live Oxy automation task');
  return { accountId, taskId };
}

/** The reminder ids a stored answer's `createAutomation` results name. */
export function reminderIdsOf(
  messages: ReadonlyArray<{ toolInvocations?: Array<{ toolName: string; result?: unknown }> }>,
): string[] {
  const ids: string[] = [];
  for (const message of messages)
    for (const invocation of message.toolInvocations ?? []) {
      if (invocation.toolName !== REMINDER_TOOL) continue;
      const automation = (invocation.result as { automation?: { id?: unknown } } | undefined)
        ?.automation;
      if (typeof automation?.id === 'string') ids.push(automation.id);
    }
  return ids;
}

async function waitUntilReady(signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(`${API_BASE_URL}/health/ready`, { signal }).catch(() => null);
    if (response?.ok) return;
    await sleep(1_000);
  }
  throw new Error('Alia API did not become ready');
}

async function main(): Promise<void> {
  const requester = canaryIdentity(process.env);
  const account = requester.accountId;
  const [
    { connectPostgres, closePostgres, getDb },
    { createGemieTransportForOxyService },
    { oxy },
    { createVoiceEnvironment },
    { chatRouteTurnRunner },
    { VOICE_CREDIT_DEPS },
    { VoiceCall },
    { listMessages, toStoredMessage },
    { deleteConversation },
    { setAutomationEnabled },
    { refreshAutomationSchedule },
  ] = await Promise.all([
    import('../db/index.js'),
    import('@gemies/server'),
    import('../lib/oxy.js'),
    import('../lib/voice/environment.js'),
    import('../lib/voice/delegated-turn.js'),
    import('../lib/voice/credits.js'),
    import('../lib/voice/call.js'),
    import('../db/chat/messageRepository.js'),
    import('../db/chat/conversationRepository.js'),
    import('../db/automation/automationDefinitionRepository.js'),
    import('../lib/structured-automation-creation.js'),
  ]);
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('No database');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1_000);
  const api = spawn(process.execPath, ['packages/api/dist/index.js'], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const transport = createGemieTransportForOxyService(oxy, { baseURL: API_BASE_URL, requester });
  try {
    await waitUntilReady(controller.signal);
    const production = createVoiceEnvironment(account);
    if (!production.kaana)
      throw new Error('Alia has no Kaana transport (Oxy service identity is not configured)');
    const pcm = new Uint8Array(await readFile(FIXTURE));
    const report = await runVoiceCanary(pcm, {
      env: {
        ...production,
        // The QA account's turns, as the chat canary enters: workload + its task.
        turns: chatRouteTurnRunner({
          baseURL: API_BASE_URL,
          fetch: transport.fetch,
          identity: 'transport',
        }),
        credits: VOICE_CREDIT_DEPS,
      },
      newCall: (env) => new VoiceCall(env, account, ''),
      stopReminder: async (conversationId) => {
        const rows = await listMessages(getDb(), account, conversationId);
        const ids = reminderIdsOf(rows.map(toStoredMessage));
        for (const id of ids) {
          // What DELETE /automations/:id does for a reminder: it stops and leaves the schedule.
          await setAutomationEnabled(getDb(), id, account, false);
          await refreshAutomationSchedule(id);
        }
        return ids.length > 0;
      },
      removeConversation: async (conversationId) => {
        await deleteConversation(getDb(), account, conversationId);
      },
    });
    const failures = judge(report);
    process.stdout.write(
      `${RESULT_MARKER} ${JSON.stringify({ schemaVersion: 1, passed: failures.length === 0, failures, ...report })}\n`,
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    transport.dispose();
    clearTimeout(timeout);
    api.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => api.once('exit', () => resolve())),
      sleep(10_000),
    ]);
    if (api.exitCode === null) api.kill('SIGKILL');
    await closePostgres();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${RESULT_MARKER} refused: ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
    process.exitCode = 1;
  });
}
