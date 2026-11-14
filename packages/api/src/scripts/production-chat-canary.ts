import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { OXY_API_URL } from '../lib/oxy.js';

type Case = Readonly<{
  label: string;
  /** Absent runs the QA account's default model — nothing here names one (ADR 0012). */
  model?: string;
  prompt: string;
  marker: string;
  deepResearch?: boolean;
  tools?: readonly Record<string, unknown>[];
  expectRefusal?: boolean;
  expectTool?: boolean;
}>;

export const PRODUCTION_CANARY_CASES: readonly Case[] = [
  {
    label: 'default-1',
    prompt: 'Reply exactly QA_INSTANT_OK_1.',
    marker: 'QA_INSTANT_OK_1',
  },
  {
    label: 'default-2',
    prompt: 'Reply exactly QA_INSTANT_OK_2.',
    marker: 'QA_INSTANT_OK_2',
  },
  {
    label: 'default-3',
    prompt: 'Reply exactly QA_AUTO_OK_1.',
    marker: 'QA_AUTO_OK_1',
  },
  {
    label: 'default-4',
    prompt: 'Reply exactly QA_AUTO_OK_2.',
    marker: 'QA_AUTO_OK_2',
  },
  {
    label: 'arithmetic-1',
    prompt: 'Calculate 17 + 25 and end with QA_THINKING_OK_42.',
    marker: 'QA_THINKING_OK_42',
  },
  {
    label: 'arithmetic-2',
    prompt: 'Calculate 19 + 24 and end with QA_THINKING_OK_43.',
    marker: 'QA_THINKING_OK_43',
  },
  {
    label: 'research-1',
    prompt: 'End your answer with QA_RESEARCH_OK_1.',
    marker: 'QA_RESEARCH_OK_1',
    deepResearch: true,
  },
  {
    label: 'research-2',
    prompt: 'End your answer with QA_RESEARCH_OK_2.',
    marker: 'QA_RESEARCH_OK_2',
    deepResearch: true,
  },
  {
    label: 'search-tool',
    prompt:
      'Use web search for the official React documentation. Include https://react.dev and end with QA_SEARCH_OK.',
    marker: 'QA_SEARCH_OK',
    expectTool: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'webSearch',
          description: 'Search the public web.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
    ],
  },
  {
    label: 'controlled-refusal',
    model: 'not-a-publisher/not-a-model',
    prompt: 'Refuse this unknown model.',
    marker: '',
    expectRefusal: true,
  },
  {
    label: 'recovery',
    prompt: 'Reply exactly QA_RECOVERY_OK.',
    marker: 'QA_RECOVERY_OK',
  },
];

const SAFE_CODES = new Set([
  'INVALID_REQUEST',
  'MODEL_NOT_FOUND',
  'REQUEST_REFUSED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'FALLBACK_EXHAUSTED',
  'TIMEOUT',
  'ROUTING_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export interface SafeResult {
  label: string;
  reference: string | null;
  code: string | null;
  retryable: boolean | null;
  synthetic: boolean;
  done: boolean;
  answerPresent: boolean;
  markerMatched: boolean;
  toolEvent: boolean;
  statusCode: number;
}

export function summarize(
  entry: Pick<Case, 'label' | 'marker'>,
  statusCode: number,
  payload: string,
): SafeResult {
  let reference: string | null = null;
  let code: string | null = null;
  let retryable: boolean | null = null;
  let synthetic = false;
  let done = false;
  let content = '';
  let toolEvent = false;
  const requestedWebSearchCallIds = new Set<string>();
  const inspect = (event: unknown, eventName?: string): void => {
    if (typeof event !== 'object' || event === null) return;
    const record = event as Record<string, unknown>;
    if (typeof record.id === 'string' && record.id.length <= 128) reference ??= record.id;
    const meta = record.alia_meta;
    if (typeof meta === 'object' && meta !== null) {
      const fields = meta as Record<string, unknown>;
      synthetic ||= fields.synthetic === true;
      if (typeof fields.retryable === 'boolean') retryable = fields.retryable;
      const error = fields.error;
      if (typeof error === 'object' && error !== null) {
        const safe = error as Record<string, unknown>;
        if (typeof safe.code === 'string' && SAFE_CODES.has(safe.code)) code ??= safe.code;
        if (typeof safe.reference === 'string' && safe.reference.length <= 128)
          reference ??= safe.reference;
      }
    }
    const error = record.error;
    if (typeof error === 'object' && error !== null) {
      const safe = error as Record<string, unknown>;
      if (typeof safe.code === 'string' && SAFE_CODES.has(safe.code)) code ??= safe.code;
      else code ??= 'REQUEST_REFUSED';
      // A failed turn (before or after output) carries these in the envelope.
      if (typeof safe.retryable === 'boolean') retryable = safe.retryable;
      if (typeof safe.reference === 'string' && safe.reference.length <= 128)
        reference ??= safe.reference;
    } else if (typeof error === 'string') code ??= 'REQUEST_REFUSED';
    const choices = record.choices;
    if (Array.isArray(choices)) {
      const delta = (choices[0] as { delta?: Record<string, unknown> } | undefined)?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (typeof call !== 'object' || call === null) continue;
          const toolCall = call as Record<string, unknown>;
          const fn = toolCall.function;
          if (
            typeof fn === 'object' &&
            fn !== null &&
            (fn as Record<string, unknown>).name === 'webSearch' &&
            typeof toolCall.id === 'string' &&
            toolCall.id.length > 0 &&
            toolCall.id.length <= 128
          )
            requestedWebSearchCallIds.add(toolCall.id);
        }
      }
    }
    const output = record.output;
    const search =
      typeof output === 'object' && output !== null
        ? (output as Record<string, unknown>)
        : undefined;
    const results = search?.results;
    const usableSearch =
      search !== undefined &&
      !('error' in search) &&
      Array.isArray(results) &&
      results.length > 0 &&
      search.count === results.length &&
      results.every((result: unknown) => {
        if (typeof result !== 'object' || result === null) return false;
        const item = result as Record<string, unknown>;
        if (typeof item.title !== 'string' || !item.title.trim()) return false;
        if (typeof item.url !== 'string') return false;
        try {
          const url = new URL(item.url);
          return url.protocol === 'https:' || url.protocol === 'http:';
        } catch {
          return false;
        }
      });
    toolEvent ||=
      eventName === 'alia.tool_result' &&
      record.name === 'webSearch' &&
      typeof record.tool_call_id === 'string' &&
      requestedWebSearchCallIds.has(record.tool_call_id) &&
      usableSearch;
  };
  if (!payload.includes('data: ')) inspect(JSON.parse(payload));
  let eventName: string | undefined;
  for (const line of payload.split(/\r?\n/)) {
    if (line.startsWith('event: ')) {
      eventName = line.slice(7);
      continue;
    }
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    inspect(JSON.parse(data), eventName);
    eventName = undefined;
  }
  return {
    label: entry.label,
    reference,
    code,
    retryable,
    synthetic,
    done,
    answerPresent: content.length > 0,
    markerMatched: entry.marker === '' || content.includes(entry.marker),
    toolEvent,
    statusCode,
  };
}

/**
 * The QA person the canary is, with the session the workflow opened for this run alone
 * (`scripts/canary-qa-session.mjs`: Oxy's normal key sign-in, signed out when the run ends). The
 * canary calls the API as that person, through the real auth middleware, like any app; no service
 * acts for anybody, and no bearer is ever stored.
 */
export function canarySession(env: NodeJS.ProcessEnv) {
  const accountId = env.ALIA_CANARY_OXY_USER_ID;
  const accessToken = env.ALIA_CANARY_SESSION_TOKEN;
  const deviceId = env.ALIA_CANARY_DEVICE_ID;
  const deviceSecret = env.ALIA_CANARY_DEVICE_SECRET;
  if (
    !accountId ||
    !/^(?:[a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      accountId,
    )
  )
    throw new Error('ALIA_CANARY_OXY_USER_ID must name one exact QA account');
  if (!accessToken || /\s/.test(accessToken))
    throw new Error('ALIA_CANARY_SESSION_TOKEN must be the QA session opened for this run');
  if (!deviceId || !deviceSecret)
    throw new Error('ALIA_CANARY_DEVICE_ID and ALIA_CANARY_DEVICE_SECRET must come with it');
  return { accountId, accessToken, deviceId, deviceSecret };
}

/** How long an access token is used before a fresh one is minted: Oxy's last 15 minutes. */
const TOKEN_REUSE_MS = 10 * 60_000;

/**
 * The QA bearer for the next request: the one the run started with, then a fresh one minted from
 * the session's device credential (`POST /session/device/token`) before the last one runs out, so
 * a run longer than one access token still calls as the same person, on the same session.
 */
export function qaBearer(
  qa: ReturnType<typeof canarySession>,
  mint: (deviceId: string, deviceSecret: string, accountId: string) => Promise<string>,
  now: () => number = Date.now,
): () => Promise<string> {
  let token = qa.accessToken;
  let since = now();
  return async () => {
    if (now() - since >= TOKEN_REUSE_MS) {
      token = await mint(qa.deviceId, qa.deviceSecret, qa.accountId);
      since = now();
    }
    return token;
  };
}

/**
 * Oxy's device-token mint (`POST /session/device/token`), as the person's own device: no bearer,
 * no service credential, possession of the run's device secret is the proof. A plain request, so
 * this one-shot builds no Oxy client of its own (only `lib/oxy.ts` does).
 */
async function mintQaToken(deviceId: string, deviceSecret: string, accountId: string) {
  const response = await fetch(new URL('/session/device/token', OXY_API_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, deviceSecret, accountId }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as { accessToken?: unknown } | null;
  if (!response.ok || typeof body?.accessToken !== 'string')
    throw new Error(`The QA session could not mint a fresh token (${response.status})`);
  return body.accessToken;
}

/** The API's own environment: everything but the run's QA session. */
export function apiEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    ALIA_CANARY_SESSION_TOKEN: _session,
    ALIA_CANARY_DEVICE_ID: _device,
    ALIA_CANARY_DEVICE_SECRET: _secret,
    ...rest
  } = env;
  return rest;
}

async function waitUntilReady(signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch('http://127.0.0.1:3001/health/ready', {
      signal,
    }).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Alia API did not become ready');
}

async function main(): Promise<void> {
  const qa = canarySession(process.env);
  const bearer = qaBearer(qa, mintQaToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1_000);
  const api = spawn(process.execPath, ['packages/api/dist/index.js'], {
    env: apiEnvironment(process.env),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    await waitUntilReady(controller.signal);
    const results: SafeResult[] = [];
    for (const entry of PRODUCTION_CANARY_CASES) {
      const response = await fetch('http://127.0.0.1:3001/alia/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${await bearer()}`,
          'content-type': 'application/json',
          'user-agent': 'alia-production-canary/1',
        },
        body: JSON.stringify({
          ...(entry.model === undefined ? {} : { model: entry.model }),
          messages: [{ role: 'user', content: entry.prompt }],
          stream: true,
          stream_options: { include_usage: true },
          ...(entry.deepResearch ? { deepResearch: true } : {}),
          ...(entry.tools ? { tools: entry.tools } : {}),
        }),
      });
      results.push(summarize(entry, response.status, await response.text()));
    }
    process.stdout.write(
      `ALIA_PRODUCTION_CANARY ${JSON.stringify({ schemaVersion: 1, conversationId: null, results })}\n`,
    );
    const ordinary = results.filter((result) => result.label !== 'controlled-refusal');
    const refusal = results.find((result) => result.label === 'controlled-refusal');
    const search = results.find((result) => result.label === 'search-tool');
    const references = ordinary.map((result) => result.reference);
    if (
      ordinary.some(
        (result) =>
          result.statusCode !== 200 ||
          result.synthetic ||
          !result.done ||
          !result.answerPresent ||
          !result.markerMatched ||
          !result.reference?.match(/^chatcmpl-[0-9a-f-]{36}$/),
      ) ||
      new Set(references).size !== ordinary.length ||
      !search?.toolEvent ||
      !refusal ||
      refusal.statusCode !== 400 ||
      refusal.code !== 'REQUEST_REFUSED' ||
      refusal.synthetic ||
      refusal.done ||
      refusal.answerPresent ||
      refusal.toolEvent ||
      results.at(-1)?.label !== 'recovery'
    )
      process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    api.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => api.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (api.exitCode === null) api.kill('SIGKILL');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
