/**
 * The QA person a production canary is (the chat canary and the voice canary alike): the session
 * the workflow opened for this run alone (`scripts/canary-qa-session.mjs`), a fresh bearer from
 * it when the first runs out, the API's environment without it, and the API's readiness.
 *
 * Runs nothing on import, so a canary bundle that imports it never runs another canary's `main`.
 */

import { OXY_API_URL } from '../lib/oxy.js';

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
export async function mintQaToken(deviceId: string, deviceSecret: string, accountId: string) {
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

export async function waitUntilReady(signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch('http://127.0.0.1:3001/health/ready', {
      signal,
    }).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Alia API did not become ready');
}
