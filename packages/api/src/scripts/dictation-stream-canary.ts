/**
 * Production canary of dictation, in two modes.
 *
 * `--mode upload` (the default) is what the Alia and Gemies apps do: the
 * composer records a clip and uploads it to `POST /v1/audio/transcriptions`,
 * whose handler is `transcribeDictation` (lib/voice/transcribe.ts). The canary
 * calls that same function with the same Kaana transport, so it picks the
 * model the apps get from the catalogue and is admitted by the same terms. It
 * uploads the recording's first seconds as a WAV clip and judges the text
 * (word recall >= 0.8) and the model that served it.
 *
 * `--mode stream` is streaming dictation (Alia ADR 0024, Kaana ADR 0006 §6):
 * one signed Kaana `transcription` session opened exactly as `DictationStream`
 * opens it, through Alia's own Kaana transport (Oxy workload identity, the
 * `alia-kaana` terms), attributed to the QA account. It streams 60 s of a
 * public-domain recording in real time, commits, waits for the last final
 * text, closes, and judges what came back:
 *
 * - at least one `transcript.interim`, one `transcript.delta` and one
 *   `transcript.done`, and no fatal error;
 * - the final text holds the reference passage (word recall >= 0.8);
 * - the session's billed `session_milliseconds` (the units `session.close`
 *   resolves with, the ones Oxy settles) covers the audio and stays within the
 *   local wall clock of the session.
 *
 * The audio is LibriVox's public-domain Gettysburg Address
 * (archive.org/details/gettysburg_address_librivox), fetched at run time,
 * checked against a pinned SHA-256, and decoded to PCM16 24 kHz mono with the
 * image's own `ffmpeg-static`, so no audio is checked in. `--audio-file` takes
 * a local recording instead (any format ffmpeg reads) with `--reference`.
 *
 * It runs inside the Alia API image as an ECS one-shot (the workflow
 * `production-dictation-canary.yml`), because only Alia's workload identity
 * holds the `alia-kaana` terms that admit a transcription session. It refuses
 * to run unless ALIA_CANARY_OXY_USER_ID names the QA account and
 * ALIA_DICTATION_CANARY_CONFIRM is `production-dictation-canary`. It never
 * prints a credential; the one result line is `ALIA_DICTATION_CANARY {json}`.
 */

import { pathToFileURL } from 'node:url';
import type { RealtimeServerEvent } from '@kaana.ai/contracts';
import type { KaanaClient } from '../lib/kaana/port.js';
import { CANARY_AUDIO, loadRecording, qaAccount } from './canary-recording.js';

const CANARY_MODEL = 'x-ai/grok-voice-transcribe-2.0';

/** The address's first sentence, spoken between 36 s and 50 s of the recording. */
export const CANARY_REFERENCE =
  'four score and seven years ago our fathers brought forth on this continent a new nation conceived in liberty and dedicated to the proposition that all men are created equal';

const CONFIRM_VALUE = 'production-dictation-canary';
const RESULT_MARKER = 'ALIA_DICTATION_CANARY';

const SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const FRAME_MS = 100;
const MIN_RECALL = 0.8;
const FINAL_WAIT_MS = 10_000;
const BILLED_SLACK_MS = 2_000;
const MAX_AUDIO_SECONDS = 120;

export type CanaryMode = 'upload' | 'stream';

export interface CanaryOptions {
  readonly mode: CanaryMode;
  readonly dryRun: boolean;
  readonly seconds: number;
  readonly model: string;
  readonly language: string | undefined;
  readonly audioFile: string | undefined;
  readonly reference: string;
}

export function parseArgs(argv: readonly string[]): CanaryOptions {
  const options = {
    mode: 'upload' as CanaryMode,
    dryRun: false,
    seconds: 60,
    model: CANARY_MODEL,
    language: 'en' as string | undefined,
    audioFile: undefined as string | undefined,
    reference: CANARY_REFERENCE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--mode') {
      const mode = value();
      if (mode !== 'upload' && mode !== 'stream')
        throw new Error('--mode must be upload or stream');
      options.mode = mode;
    } else if (flag === '--seconds') options.seconds = Number(value());
    else if (flag === '--model') options.model = value();
    else if (flag === '--language') options.language = value() || undefined;
    else if (flag === '--audio-file') options.audioFile = value();
    else if (flag === '--reference') options.reference = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  if (
    !Number.isInteger(options.seconds) ||
    options.seconds < 10 ||
    options.seconds > MAX_AUDIO_SECONDS
  )
    throw new Error(`--seconds must be an integer from 10 to ${MAX_AUDIO_SECONDS}`);
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(options.model))
    throw new Error('--model must be publisher/model');
  if (options.audioFile !== undefined && options.reference === CANARY_REFERENCE)
    throw new Error('--audio-file needs --reference, the words it contains');
  return options;
}

/** The QA account, or a refusal naming what is missing; never echoed whole. */
export function canaryAccount(env: NodeJS.ProcessEnv): string {
  if (env.ALIA_DICTATION_CANARY_CONFIRM !== CONFIRM_VALUE)
    throw new Error(`ALIA_DICTATION_CANARY_CONFIRM must be ${CONFIRM_VALUE}`);
  return qaAccount(env);
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** How much of the reference the transcript holds, in order (LCS / reference length). */
export function recall(reference: string, transcript: string): number {
  const want = words(reference);
  const got = words(transcript);
  if (want.length === 0) return 0;
  let previous = new Array<number>(got.length + 1).fill(0);
  for (const word of want) {
    const current = new Array<number>(got.length + 1).fill(0);
    for (let column = 1; column <= got.length; column += 1) {
      current[column] =
        got[column - 1] === word
          ? (previous[column - 1] ?? 0) + 1
          : Math.max(previous[column] ?? 0, current[column - 1] ?? 0);
    }
    previous = current;
  }
  return (previous[got.length] ?? 0) / want.length;
}

export interface CanaryReport {
  mode: 'stream';
  model: string;
  sessionId: string | null;
  audioMs: number;
  wallMs: number;
  counts: { interim: number; delta: number; done: number; errors: number };
  firstInterimMs: number | null;
  finalText: string;
  recall: number;
  billedSessionMs: number | null;
  units: ReadonlyArray<{ unit: string; quantity: number }>;
  fatal: string | null;
}

/** Every reason the report fails; empty means the canary passed. */
export function judge(report: CanaryReport): string[] {
  const failures: string[] = [];
  if (report.fatal !== null) failures.push(`fatal: ${report.fatal}`);
  if (report.counts.interim < 1) failures.push('no transcript.interim');
  if (report.counts.delta < 1) failures.push('no transcript.delta');
  if (report.counts.done < 1) failures.push('no transcript.done');
  if (report.recall < MIN_RECALL)
    failures.push(`final text recall ${report.recall.toFixed(2)} < ${MIN_RECALL}`);
  if (report.billedSessionMs === null) failures.push('no session_milliseconds billed');
  else {
    if (report.billedSessionMs < report.audioMs * 0.95)
      failures.push(`billed ${report.billedSessionMs} ms < the ${report.audioMs} ms of audio sent`);
    if (report.billedSessionMs > report.wallMs + BILLED_SLACK_MS)
      failures.push(`billed ${report.billedSessionMs} ms > wall clock ${report.wallMs} ms`);
  }
  return failures;
}

/** 24 kHz mono of the recording's first `seconds`: PCM16 to stream, a WAV clip to upload. */
export function loadAudio(options: CanaryOptions): Promise<Buffer> {
  return loadRecording({
    seconds: options.seconds,
    container: options.mode === 'upload' ? 'wav' : 's16le',
    ...(options.audioFile === undefined ? {} : { audioFile: options.audioFile }),
  });
}

export interface UploadReport {
  mode: 'upload';
  /** The model that served the clip, as Kaana answered; empty when none did. */
  model: string;
  audioMs: number;
  wallMs: number;
  finalText: string;
  recall: number;
  /** The dictation failure code, as the upload route would answer it. */
  fatal: string | null;
}

/** Every reason an upload report fails; empty means the canary passed. */
export function judgeUpload(report: UploadReport): string[] {
  const failures: string[] = [];
  if (report.fatal !== null) failures.push(`fatal: ${report.fatal}`);
  else if (report.model === '') failures.push('no model served the clip');
  if (report.recall < MIN_RECALL)
    failures.push(`final text recall ${report.recall.toFixed(2)} < ${MIN_RECALL}`);
  return failures;
}

/** One clip through the upload route's own transcription, as the apps dictate. */
export async function runUploadCanary(
  options: CanaryOptions,
  wav: Uint8Array,
  deps: { readonly kaana: KaanaClient; readonly account: string; readonly now?: () => number },
): Promise<UploadReport> {
  const now = deps.now ?? Date.now;
  const { transcribeDictation, TranscriptionError } = await import('../lib/voice/transcribe.js');
  const report: UploadReport = {
    mode: 'upload',
    model: '',
    audioMs: options.seconds * 1000,
    wallMs: 0,
    finalText: '',
    recall: 0,
    fatal: null,
  };
  const startedAt = now();
  try {
    const result = await transcribeDictation(deps.kaana, deps.account, {
      audio: wav,
      mediaType: 'audio/wav',
      durationMs: report.audioMs,
      ...(options.language === undefined ? {} : { language: options.language }),
    });
    report.model = result.model;
    report.finalText = result.text;
  } catch (error) {
    report.fatal = error instanceof TranscriptionError ? error.code : 'TRANSCRIPTION_FAILED';
  }
  report.wallMs = now() - startedAt;
  report.recall = recall(options.reference, report.finalText);
  return report;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RunDependencies {
  readonly kaana: KaanaClient;
  readonly account: string;
  /** Real time by default; tests pass 0 to stream at once. */
  readonly frameDelayMs?: number;
  readonly finalWaitMs?: number;
  readonly now?: () => number;
}

/** Open, stream, commit, wait for the last final text, close, and report. */
export async function runCanary(
  options: CanaryOptions,
  pcm: Uint8Array,
  deps: RunDependencies,
): Promise<CanaryReport> {
  const now = deps.now ?? Date.now;
  const frameDelayMs = deps.frameDelayMs ?? FRAME_MS;
  const audioMs = Math.floor(pcm.byteLength / BYTES_PER_MS);
  const report: CanaryReport = {
    mode: 'stream',
    model: options.model,
    sessionId: null,
    audioMs,
    wallMs: 0,
    counts: { interim: 0, delta: 0, done: 0, errors: 0 },
    firstInterimMs: null,
    finalText: '',
    recall: 0,
    billedSessionMs: null,
    units: [],
    fatal: null,
  };
  const startedAt = now();
  const session = await deps.kaana.realtime.connect(
    {
      model: options.model,
      type: 'session.open',
      kind: 'transcription',
      transport: 'websocket',
      config: {
        inputAudioFormat: 'pcm16_24khz',
        turnDetection: { type: 'server_vad', createResponse: false, interruptResponse: false },
        inputAudioTranscription: {
          ...(options.language === undefined ? {} : { language: options.language }),
          interimResults: true,
        },
      },
      limits: {
        maxDurationMs: (MAX_AUDIO_SECONDS + 30) * 1000,
        idleTimeoutMs: 30_000,
        maxInputAudioBytes: (MAX_AUDIO_SECONDS + 30) * 1000 * BYTES_PER_MS,
        maxOutputAudioBytes: 1,
        maxResponses: 1,
      },
      clientSessionId: `canary_${startedAt.toString(36)}`,
      labels: { surface: 'alia-dictation-canary' },
    },
    { onBehalfOfUserId: deps.account },
  );
  report.sessionId = session.sessionId;
  const finals = new Map<string, string>();
  const order: string[] = [];
  let open = 0;
  let firstAudioAt: number | null = null;
  let finalWaiter = null as (() => void) | null;

  const reading = (async () => {
    for await (const event of session as AsyncIterable<RealtimeServerEvent>) {
      switch (event.type) {
        case 'transcript.interim':
          report.counts.interim += 1;
          if (report.firstInterimMs === null && firstAudioAt !== null)
            report.firstInterimMs = now() - firstAudioAt;
          break;
        case 'transcript.delta':
          report.counts.delta += 1;
          if (!finals.has(event.itemId)) {
            finals.set(event.itemId, '');
            order.push(event.itemId);
            open += 1;
          }
          break;
        case 'transcript.done':
          report.counts.done += 1;
          if (!order.includes(event.itemId)) order.push(event.itemId);
          else open -= 1;
          finals.set(event.itemId, event.transcript);
          if (open <= 0) finalWaiter?.();
          break;
        case 'error':
          report.counts.errors += 1;
          if (event.fatal) report.fatal = event.error.code;
          break;
        default:
          break;
      }
    }
  })();

  const frameBytes = FRAME_MS * BYTES_PER_MS;
  for (let offset = 0; offset < pcm.byteLength && report.fatal === null; offset += frameBytes) {
    firstAudioAt ??= now();
    session.appendAudio(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength)));
    if (frameDelayMs > 0) await sleep(frameDelayMs);
  }
  session.send({ type: 'input_audio.commit' });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, deps.finalWaitMs ?? FINAL_WAIT_MS);
    finalWaiter = () => {
      clearTimeout(timer);
      resolve();
    };
    if (open <= 0 && report.counts.done > 0) finalWaiter();
  });
  const units = await session.close();
  report.wallMs = now() - startedAt;
  await Promise.race([reading.catch(() => undefined), sleep(5_000)]);
  report.units = units.map(({ unit, quantity }) => ({ unit, quantity }));
  report.billedSessionMs =
    units.find((quantity) => quantity.unit === 'session_milliseconds')?.quantity ?? null;
  report.finalText = order
    .map((item) => finals.get(item) ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  report.recall = recall(options.reference, report.finalText);
  return report;
}

export function plan(options: CanaryOptions): string {
  if (options.mode === 'upload')
    return [
      `mode             upload: POST /v1/audio/transcriptions's own transcribeDictation, as the apps dictate`,
      `model            the catalogue's transcription line the apps get (cheapest that takes audio/wav)`,
      `audio            ${options.audioFile ?? CANARY_AUDIO.url} (first ${options.seconds} s, WAV PCM16 24 kHz mono)`,
      `identity         Alia's Oxy workload transport, attributed to ALIA_CANARY_OXY_USER_ID`,
      `asserts          a model served it, no failure, recall >= ${MIN_RECALL} of: "${options.reference}"`,
    ].join('\n');
  return [
    `mode             stream: a Kaana transcription session, as streaming dictation opens it`,
    `model            ${options.model} (kind transcription, pcm16_24khz, server_vad, interimResults)`,
    `audio            ${options.audioFile ?? CANARY_AUDIO.url} (first ${options.seconds} s, PCM16 24 kHz mono, streamed in ${FRAME_MS} ms frames in real time)`,
    `identity         Alia's Oxy workload transport (alia-kaana terms), attributed to ALIA_CANARY_OXY_USER_ID`,
    `asserts          interim >= 1, delta >= 1, done >= 1, no fatal error, recall >= ${MIN_RECALL} of: "${options.reference}"`,
    `                 session_milliseconds >= 95% of audio sent and <= the session's wall clock + ${BILLED_SLACK_MS} ms`,
    `cost             about USD ${(((options.seconds + 5) / 3600) * 0.2).toFixed(4)} at $0.20/h of session`,
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) {
    process.stdout.write(`${plan(options)}\n(dry run: nothing fetched, nothing opened)\n`);
    return;
  }
  const account = canaryAccount(process.env);
  const { getKaanaClient } = await import('../lib/kaana/transport.js');
  const kaana = getKaanaClient(account);
  if (!kaana)
    throw new Error('Alia has no Kaana transport (Oxy service identity is not configured)');
  try {
    const audio = await loadAudio(options);
    const report =
      options.mode === 'upload'
        ? await runUploadCanary(options, audio, { kaana, account })
        : await runCanary(options, audio, { kaana, account });
    const failures = report.mode === 'upload' ? judgeUpload(report) : judge(report);
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
