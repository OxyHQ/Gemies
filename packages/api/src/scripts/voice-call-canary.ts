/**
 * Production canary of a voice call (ADR 0041 §7): one real call through
 * Gemies' own voice socket, `GET /v1/voice/session`, as the QA person.
 *
 * It runs inside the live API image as an ECS one-shot
 * (`production-voice-canary.yml`), like the chat canary: it starts that image's
 * API and opens the socket on its loopback port with the QA session the
 * workflow signed in for this run alone (`scripts/canary-qa-session.mjs`), so
 * the call is what an app's call is — the socket's own `auth`, the plan check,
 * the catalogue's default `live` line and its voice, the credit meter, the
 * one-call registry, the persona, and every turn the voice hands over answered
 * by the chat route as that person.
 *
 * It speaks a recorded request for a reminder (`fixtures/voice-canary-reminder.pcm`,
 * 24 kHz PCM16 mono, synthesized offline) in real time, then silence, until the
 * answer has been stored and spoken; hangs up; then stops the reminder the way
 * the app does (`DELETE /automations/:id`) and deletes the canary's
 * conversation. It passes when:
 *
 * - the call was ready on a line and no error came;
 * - exactly one turn was answered and stored (`messages.saved`), and that
 *   answer ran `createAutomation` successfully;
 * - audio came back after the answer was stored (the answer was spoken);
 * - the call closed `hangup`, which the server sends only once it has closed
 *   the Kaana session, settled the minutes and ended the `voice_calls` row;
 * - the reminder was stopped.
 *
 * It refuses to run unless ALIA_VOICE_CANARY_CONFIRM is
 * `production-voice-canary` and the QA session is present. It never prints a
 * credential, the prompt or the answer; the one result line is
 * `ALIA_VOICE_CANARY {json}`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  decodeAssistantAudioFrame,
  type ProductVoice,
  VOICE_PROTOCOL_VERSION,
  VOICE_SESSION_PATH,
} from '../lib/voice/protocol.js';
import {
  apiEnvironment,
  canarySession,
  mintQaToken,
  qaBearer,
  waitUntilReady,
} from './canary-qa-person.js';

const CONFIRM_VALUE = 'production-voice-canary';
const RESULT_MARKER = 'ALIA_VOICE_CANARY';
const API_BASE_URL = 'http://127.0.0.1:3001';
/** The tool a reminder is made with (`lib/tools/automation-create.ts`). */
export const REMINDER_TOOL = 'createAutomation';

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

export interface VoiceCanaryOptions {
  readonly dryRun: boolean;
  readonly voice: ProductVoice;
  /** The language the recorded request is in. */
  readonly locale: string;
}

export function parseVoiceArgs(argv: readonly string[]): VoiceCanaryOptions {
  const options = { dryRun: false, voice: 'female' as ProductVoice, locale: 'en-US' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--voice') {
      const voice = value();
      if (voice !== 'female' && voice !== 'male') throw new Error('--voice must be female or male');
      options.voice = voice;
    } else if (flag === '--locale') options.locale = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(options.locale))
    throw new Error('--locale must be a BCP 47 tag');
  return options;
}

/** The explicit confirmation, then the QA session (`canarySession`); never echoed. */
export function canaryIdentity(env: NodeJS.ProcessEnv): ReturnType<typeof canarySession> {
  if (env.ALIA_VOICE_CANARY_CONFIRM !== CONFIRM_VALUE)
    throw new Error(`ALIA_VOICE_CANARY_CONFIRM must be ${CONFIRM_VALUE}`);
  return canarySession(env);
}

export interface VoiceCanaryReport {
  /** The call's `voice_calls` id, which the API's logs correlate with Kaana's request id. */
  callId: string | null;
  /** The line that served the call (`publisher/model@revision`). */
  model: string | null;
  audioMs: number;
  /** Turns answered and stored (`messages.saved`). */
  answeredTurns: number;
  /** The tools of the answered turn, by name. */
  tools: Array<{ name: string; ok: boolean }>;
  /** Voice audio received at all, and after the answer was stored. */
  audioBytes: number;
  answerAudioBytes: number;
  /** From the end of the request to the first audio of the answer. */
  firstAnswerAudioMs: number | null;
  closedReason: string | null;
  errors: string[];
  reminderStopped: boolean;
  conversationRemoved: boolean;
  wallMs: number;
}

/** Every reason the report fails; empty means the canary passed. */
export function judgeVoice(report: VoiceCanaryReport): string[] {
  const failures: string[] = [];
  if (report.model === null) failures.push('the call was never ready');
  if (report.errors.length > 0) failures.push(`call errors: ${report.errors.join(', ')}`);
  if (report.answeredTurns !== 1)
    failures.push(`${report.answeredTurns} turns answered and stored, not exactly one`);
  if (!report.tools.some((tool) => tool.name === REMINDER_TOOL && tool.ok))
    failures.push(`the answered turn did not run ${REMINDER_TOOL}`);
  if (report.audioBytes === 0) failures.push('no audio came back');
  if (report.answerAudioBytes === 0) failures.push('the answer was not spoken');
  if (report.closedReason !== 'hangup') failures.push(`closed ${report.closedReason ?? 'never'}`);
  if (!report.reminderStopped) failures.push('the reminder was not stopped');
  return failures;
}

/** The reminder ids a stored conversation's `createAutomation` results name. */
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

export interface VoiceRunDependencies {
  /** The API the call is made on (`http://127.0.0.1:3001` in the one-shot). */
  readonly baseURL: string;
  /** The QA bearer for the next request (`qaBearer`). */
  readonly bearer: () => Promise<string>;
  /** Real time by default; tests pass 0. */
  readonly frameDelayMs?: number;
  readonly quietAfterAnswerMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ServerEvent = Record<string, unknown> & { type: string };

/** Call through the socket, speak, wait for the spoken answer, hang up, clean up, report. */
export async function runVoiceCanary(
  options: VoiceCanaryOptions,
  pcm: Uint8Array,
  deps: VoiceRunDependencies,
): Promise<VoiceCanaryReport> {
  const now = deps.now ?? Date.now;
  const frameDelayMs = deps.frameDelayMs ?? FRAME_MS;
  const quietMs = deps.quietAfterAnswerMs ?? QUIET_AFTER_ANSWER_MS;
  const startedAt = now();
  const deadline = startedAt + (deps.timeoutMs ?? CALL_TIMEOUT_MS);
  const conversationId = randomUUID();
  const events: ServerEvent[] = [];
  const report: VoiceCanaryReport = {
    callId: null,
    model: null,
    audioMs: Math.floor(pcm.byteLength / BYTES_PER_MS),
    answeredTurns: 0,
    tools: [],
    audioBytes: 0,
    answerAudioBytes: 0,
    firstAnswerAudioMs: null,
    closedReason: null,
    errors: [],
    reminderStopped: false,
    conversationRemoved: false,
    wallMs: 0,
  };
  let spokeAt: number | null = null;
  let lastAudioAt = 0;
  let closed = false;
  const saved = () => events.some((event) => event.type === 'messages.saved');

  const ws = new WebSocket(`${deps.baseURL.replace(/^http/, 'ws')}${VOICE_SESSION_PATH}`);
  ws.binaryType = 'nodebuffer';
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const frame = decodeAssistantAudioFrame(new Uint8Array(data as Buffer));
      if (!frame) return;
      report.audioBytes += frame.pcm.byteLength;
      lastAudioAt = now();
      if (saved()) {
        report.answerAudioBytes += frame.pcm.byteLength;
        if (report.firstAnswerAudioMs === null && spokeAt !== null)
          report.firstAnswerAudioMs = now() - spokeAt;
      }
      return;
    }
    const event = JSON.parse(data.toString()) as ServerEvent;
    events.push(event);
    if (event.type === 'session.accepted') report.callId = String(event.callId);
    if (event.type === 'session.ready')
      report.model = String((event.model as { id?: unknown } | undefined)?.id ?? '');
    if (event.type === 'error') report.errors.push(String(event.code));
    if (event.type === 'session.closed') report.closedReason = String(event.reason);
  });
  ws.on('close', () => {
    closed = true;
  });
  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  const until = async (ready: () => boolean) => {
    while (!ready() && !closed && now() < deadline) await sleep(20);
    return ready();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    send({ type: 'auth', token: await deps.bearer() });
    if (await until(() => events.some((event) => event.type === 'auth.ok'))) {
      send({
        type: 'session.start',
        protocol: VOICE_PROTOCOL_VERSION,
        conversationId,
        voice: options.voice,
        locale: options.locale,
      });
    }
    if (await until(() => report.model !== null)) {
      const frameBytes = FRAME_MS * BYTES_PER_MS;
      const silence = new Uint8Array(frameBytes);
      // The request in real time, then silence: the voice decides when the person finished.
      for (let offset = 0; offset < pcm.byteLength && !closed; offset += frameBytes) {
        ws.send(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.byteLength)));
        await sleep(frameDelayMs);
      }
      spokeAt = now();
      while (!closed && now() < deadline) {
        if (saved() && report.answerAudioBytes > 0 && now() - lastAudioAt >= quietMs) break;
        ws.send(silence);
        await sleep(Math.max(frameDelayMs, 1));
      }
    }
    send({ type: 'session.end' });
    await until(() => report.closedReason !== null);
  } finally {
    ws.close();
  }

  const answers = new Set(
    events
      .filter((event) => event.type === 'messages.saved')
      .flatMap((event) => event.messageIds as string[]),
  );
  report.answeredTurns = events.filter((event) => event.type === 'messages.saved').length;
  report.tools = events
    .filter((event) => event.type === 'tool.finished' && answers.has(String(event.messageId)))
    .map((event) => ({ name: String(event.name), ok: event.ok === true }));

  // The cleanup, as the QA person through the app's own routes.
  const authorized = async () => ({ authorization: `Bearer ${await deps.bearer()}` });
  const stored = await fetch(`${deps.baseURL}/conversations/${conversationId}`, {
    headers: await authorized(),
  }).catch(() => null);
  const body = stored?.ok
    ? ((await stored.json().catch(() => null)) as {
        messages?: Parameters<typeof reminderIdsOf>[0];
      } | null)
    : null;
  const reminders = reminderIdsOf(body?.messages ?? []);
  let stopped = reminders.length > 0;
  for (const id of reminders) {
    const response = await fetch(`${deps.baseURL}/automations/${id}`, {
      method: 'DELETE',
      headers: await authorized(),
    }).catch(() => null);
    stopped &&= response?.ok === true;
  }
  report.reminderStopped = stopped;
  const removed = await fetch(`${deps.baseURL}/conversations/${conversationId}`, {
    method: 'DELETE',
    headers: await authorized(),
  }).catch(() => null);
  report.conversationRemoved = removed?.ok === true;
  report.wallMs = now() - startedAt;
  return report;
}

export function voicePlan(options: VoiceCanaryOptions): string {
  return [
    `call             GET ${VOICE_SESSION_PATH} on the live image's own API, protocol ${VOICE_PROTOCOL_VERSION}, ${options.voice} voice, ${options.locale}`,
    `line             the catalogue's default live line, as every call opens it (ADR 0041)`,
    `audio            a recorded request for a reminder (${FIXTURE.split('/').pop()}), then silence, PCM16 24 kHz mono in real time`,
    `identity         the QA session the workflow signed in for this run, through the socket's own auth`,
    `asserts          ready, one answered turn that ran ${REMINDER_TOOL}, its answer spoken, closed hangup, the reminder stopped`,
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseVoiceArgs(process.argv.slice(2));
  if (options.dryRun) {
    process.stdout.write(`${voicePlan(options)}\n(dry run: nothing opened)\n`);
    return;
  }
  const qa = canaryIdentity(process.env);
  const bearer = qaBearer(qa, mintQaToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1_000);
  const api = spawn(process.execPath, ['packages/api/dist/index.js'], {
    env: apiEnvironment(process.env),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitUntilReady(controller.signal);
    const pcm = new Uint8Array(await readFile(FIXTURE));
    const report = await runVoiceCanary(options, pcm, { baseURL: API_BASE_URL, bearer });
    const failures = judgeVoice(report);
    process.stdout.write(
      `${RESULT_MARKER} ${JSON.stringify({ schemaVersion: 2, passed: failures.length === 0, failures, ...report })}\n`,
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    api.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => api.once('exit', () => resolve())),
      sleep(10_000),
    ]);
    if (api.exitCode === null) api.kill('SIGKILL');
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
