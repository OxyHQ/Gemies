/**
 * Production canary of a voice call: one Kaana `conversation` session opened
 * the way a Gemies call opens it (lib/voice/call.ts): the model and voice
 * picked from the catalogue by the same `rankRealtimeCandidates`, server VAD
 * that creates the response, the same session limits, through Gemies' own
 * Kaana transport, attributed to the QA account. It speaks the first seconds
 * of a public-domain recording in real time, then silence so the turn ends,
 * waits for the spoken answer, closes, and judges what came back:
 *
 * - the session opened and at least one response was created and finished;
 * - the answer was audio (at least one `output_audio.delta`), with no fatal
 *   error;
 * - the session's billed units (what `session.close` resolves with, what
 *   Kaana settles) are not empty.
 *
 * It runs inside the Gemies API image as an ECS one-shot
 * (`production-voice-canary.yml`), because only that workload identity holds
 * the terms that admit a voice session. It refuses to run unless
 * ALIA_CANARY_OXY_USER_ID names the QA account and ALIA_VOICE_CANARY_CONFIRM is
 * `production-voice-canary`. It never prints a credential, prompt or answer;
 * the one result line is `ALIA_VOICE_CANARY {json}`.
 */

import { pathToFileURL } from 'node:url';
import type { RealtimeServerEvent } from '@kaana.ai/contracts';
import type { KaanaClient } from '../lib/kaana/port.js';
import { rankRealtimeCandidates } from '../lib/models/voice-models.js';
import { sessionLimits } from '../lib/voice/call-contract.js';
import type { ProductVoice } from '../lib/voice/protocol.js';
import { loadRecording, qaAccount } from './canary-recording.js';

const CONFIRM_VALUE = 'production-voice-canary';
const RESULT_MARKER = 'ALIA_VOICE_CANARY';
const SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const FRAME_MS = 100;
const SILENCE_MS = 2_000;
const ANSWER_WAIT_MS = 20_000;
const MAX_CALL_MS = 120_000;

export interface VoiceCanaryOptions {
  readonly dryRun: boolean;
  readonly seconds: number;
  readonly voice: ProductVoice;
  readonly locale: string;
}

export function parseVoiceArgs(argv: readonly string[]): VoiceCanaryOptions {
  const options = { dryRun: false, seconds: 8, voice: 'female' as ProductVoice, locale: 'en' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--seconds') options.seconds = Number(value());
    else if (flag === '--voice') {
      const voice = value();
      if (voice !== 'female' && voice !== 'male') throw new Error('--voice must be female or male');
      options.voice = voice;
    } else if (flag === '--locale') options.locale = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isInteger(options.seconds) || options.seconds < 3 || options.seconds > 30)
    throw new Error('--seconds must be an integer from 3 to 30');
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(options.locale))
    throw new Error('--locale must be a BCP 47 tag');
  return options;
}

/** The QA account, or a refusal naming what is missing; never echoed whole. */
export function canaryAccount(env: NodeJS.ProcessEnv): string {
  if (env.ALIA_VOICE_CANARY_CONFIRM !== CONFIRM_VALUE)
    throw new Error(`ALIA_VOICE_CANARY_CONFIRM must be ${CONFIRM_VALUE}`);
  return qaAccount(env);
}

export interface VoiceCanaryReport {
  model: string;
  sessionId: string | null;
  audioMs: number;
  wallMs: number;
  counts: { responsesCreated: number; responsesDone: number; audioDeltas: number; errors: number };
  firstAudioMs: number | null;
  units: ReadonlyArray<{ unit: string; quantity: number }>;
  fatal: string | null;
}

/** Every reason the report fails; empty means the canary passed. */
export function judgeVoice(report: VoiceCanaryReport): string[] {
  const failures: string[] = [];
  if (report.fatal !== null) failures.push(`fatal: ${report.fatal}`);
  if (report.sessionId === null) failures.push('no session opened');
  if (report.counts.responsesCreated < 1) failures.push('no response.created');
  if (report.counts.audioDeltas < 1) failures.push('no output_audio.delta');
  if (report.counts.responsesDone < 1) failures.push('no response.done');
  if (!report.units.some((unit) => unit.quantity > 0)) failures.push('no units billed');
  return failures;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface VoiceRunDependencies {
  readonly kaana: KaanaClient;
  readonly account: string;
  /** Real time by default; tests pass 0 to stream at once. */
  readonly frameDelayMs?: number;
  readonly answerWaitMs?: number;
  readonly now?: () => number;
}

/** Pick the call's model as a call does, speak, wait for the answer, close, report. */
export async function runVoiceCanary(
  options: VoiceCanaryOptions,
  pcm: Uint8Array,
  deps: VoiceRunDependencies,
): Promise<VoiceCanaryReport> {
  const now = deps.now ?? Date.now;
  const frameDelayMs = deps.frameDelayMs ?? FRAME_MS;
  const report: VoiceCanaryReport = {
    model: '',
    sessionId: null,
    audioMs: Math.floor(pcm.byteLength / BYTES_PER_MS),
    wallMs: 0,
    counts: { responsesCreated: 0, responsesDone: 0, audioDeltas: 0, errors: 0 },
    firstAudioMs: null,
    units: [],
    fatal: null,
  };
  const startedAt = now();
  const models = await deps.kaana.models.list({ onBehalfOfUserId: deps.account });
  const candidate = rankRealtimeCandidates(models, { voice: options.voice })[0];
  if (!candidate) {
    report.fatal = 'no_realtime_candidate';
    return report;
  }
  report.model = candidate.model.modelId;
  const session = await deps.kaana.realtime.connect(
    {
      model: candidate.model.modelId,
      type: 'session.open',
      kind: 'conversation',
      transport: 'websocket',
      config: {
        instructions: 'This is an automated check. Answer in one short sentence.',
        outputModalities: ['audio'],
        voice: candidate.voiceId,
        inputAudioFormat: 'pcm16_24khz',
        outputAudioFormat: 'pcm16_24khz',
        turnDetection: { type: 'server_vad', createResponse: true, interruptResponse: true },
        inputAudioTranscription: { language: options.locale },
      },
      limits: sessionLimits(MAX_CALL_MS, 30_000),
      clientSessionId: `voice_canary_${startedAt.toString(36)}`,
      labels: { surface: 'alia-voice-canary' },
    },
    { onBehalfOfUserId: deps.account },
  );
  report.sessionId = session.sessionId;
  let answered = null as (() => void) | null;
  let spokenAt: number | null = null;
  const reading = (async () => {
    for await (const event of session as AsyncIterable<RealtimeServerEvent>) {
      switch (event.type) {
        case 'response.created':
          report.counts.responsesCreated += 1;
          break;
        case 'output_audio.delta':
          report.counts.audioDeltas += 1;
          if (report.firstAudioMs === null && spokenAt !== null)
            report.firstAudioMs = now() - spokenAt;
          break;
        case 'response.done':
          report.counts.responsesDone += 1;
          if (report.counts.audioDeltas > 0) answered?.();
          break;
        case 'error':
          report.counts.errors += 1;
          if (event.fatal) {
            report.fatal = event.error.code;
            answered?.();
          }
          break;
        default:
          break;
      }
    }
  })();

  const frameBytes = FRAME_MS * BYTES_PER_MS;
  const silence = new Uint8Array(SILENCE_MS * BYTES_PER_MS);
  const speech = new Uint8Array(pcm.byteLength + silence.byteLength);
  speech.set(pcm, 0);
  speech.set(silence, pcm.byteLength);
  for (let offset = 0; offset < speech.byteLength && report.fatal === null; offset += frameBytes) {
    session.appendAudio(speech.subarray(offset, Math.min(offset + frameBytes, speech.byteLength)));
    if (offset >= pcm.byteLength) spokenAt ??= now();
    if (frameDelayMs > 0) await sleep(frameDelayMs);
  }
  spokenAt ??= now();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, deps.answerWaitMs ?? ANSWER_WAIT_MS);
    answered = () => {
      clearTimeout(timer);
      resolve();
    };
    if (report.fatal !== null || (report.counts.responsesDone > 0 && report.counts.audioDeltas > 0))
      answered();
  });
  const units = await session.close();
  report.wallMs = now() - startedAt;
  await Promise.race([reading.catch(() => undefined), sleep(5_000)]);
  report.units = units.map(({ unit, quantity }) => ({ unit, quantity }));
  return report;
}

export function voicePlan(options: VoiceCanaryOptions): string {
  return [
    `call             kind conversation, server_vad creating the response, as lib/voice/call.ts opens it`,
    `model            the cheapest catalogue line rankRealtimeCandidates gives a ${options.voice} voice`,
    `audio            the first ${options.seconds} s of the LibriVox Gettysburg Address, then ${SILENCE_MS} ms of silence, PCM16 24 kHz mono in real time`,
    `identity         Gemies' Oxy workload transport, attributed to ALIA_CANARY_OXY_USER_ID`,
    `asserts          a session, response.created, output_audio.delta, response.done, no fatal error, billed units`,
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseVoiceArgs(process.argv.slice(2));
  if (options.dryRun) {
    process.stdout.write(`${voicePlan(options)}\n(dry run: nothing fetched, nothing opened)\n`);
    return;
  }
  const account = canaryAccount(process.env);
  const { getKaanaClient } = await import('../lib/kaana/transport.js');
  const kaana = getKaanaClient(account);
  if (!kaana)
    throw new Error('Gemies has no Kaana transport (Oxy service identity is not configured)');
  try {
    const pcm = await loadRecording({ seconds: options.seconds, container: 's16le' });
    const report = await runVoiceCanary(options, pcm, { kaana, account });
    const failures = judgeVoice(report);
    process.stdout.write(
      `${RESULT_MARKER} ${JSON.stringify({ schemaVersion: 1, passed: failures.length === 0, failures, ...report })}\n`,
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    kaana.dispose?.();
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
