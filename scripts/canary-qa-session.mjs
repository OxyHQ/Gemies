#!/usr/bin/env bun
/**
 * The production chat canary's QA session: opened fresh for one run, closed at its end.
 *
 * `open` signs the dedicated QA account in through Oxy's normal key sign-in (challenge, signature,
 * verification: the same path any app's account dialog uses) and prints the new session, `{
 * accessToken, sessionId, deviceId, deviceSecret }`, as one JSON line on stdout: the device
 * credential lets the run mint a fresh access token when the first one (15 minutes) runs out, and
 * dies with the session. `close` signs that session out. The
 * canary then calls the Gemies API as that person, with that bearer, through the real auth
 * middleware; no service acts for anyone (oxy ADR 0066), and no bearer outlives the run.
 *
 * The QA account's own credential is its key pair, `ALIA_CANARY_OXY_QA_KEY` (`{ publicKey,
 * privateKey }`, a repository secret), and its exact id `ALIA_CANARY_OXY_USER_ID`: a key that
 * signs in as any other account is refused. Nothing here prints the key, the bearer is printed
 * only by `open` for the workflow to mask, and no error prints a body, header or URL.
 */
import { OxyServices } from '@oxy.so/core';
import { signMessage } from '@oxy.so/protocol/sign';

const OXY_API_URL = 'https://api.oxy.so';
const ACCOUNT_ID =
  /^(?:[a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function qaAccountId(env) {
  const accountId = env.ALIA_CANARY_OXY_USER_ID;
  if (!accountId || !ACCOUNT_ID.test(accountId))
    throw new Error('ALIA_CANARY_OXY_USER_ID must name one exact QA account');
  return accountId;
}

function qaKey(env) {
  let parsed;
  try {
    parsed = JSON.parse(env.ALIA_CANARY_OXY_QA_KEY ?? '');
  } catch {
    throw new Error('ALIA_CANARY_OXY_QA_KEY must be the QA key pair as JSON');
  }
  if (
    typeof parsed?.publicKey !== 'string' ||
    typeof parsed?.privateKey !== 'string' ||
    parsed.publicKey.length === 0 ||
    parsed.privateKey.length === 0
  )
    throw new Error('ALIA_CANARY_OXY_QA_KEY must carry publicKey and privateKey');
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

export async function openQaSession(env, client = new OxyServices({ baseURL: OXY_API_URL })) {
  const accountId = qaAccountId(env);
  const key = qaKey(env);
  try {
    const { challenge } = await client.auth.requestChallenge(key.publicKey, { retry: false });
    const timestamp = Date.now();
    const signature = await signMessage(
      `auth:${key.publicKey}:${challenge}:${timestamp}`,
      key.privateKey,
    );
    const session = await client.auth.verifyChallenge(
      key.publicKey,
      challenge,
      signature,
      timestamp,
      'Gemies production chat canary',
      undefined,
      { retry: false },
      { plantTokens: true },
    );
    if (session.user?.id !== accountId) {
      if (session.sessionId) await client.session.logout(session.sessionId).catch(() => undefined);
      throw new Error('The QA key signed in as another account');
    }
    if (!session.accessToken || !session.deviceId || !session.deviceSecret)
      throw new Error('The QA sign-in returned no device session');
    return {
      accessToken: session.accessToken,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      deviceSecret: session.deviceSecret,
    };
  } finally {
    client.dispose();
  }
}

export async function closeQaSession(env, client = new OxyServices({ baseURL: OXY_API_URL })) {
  const { ALIA_CANARY_SESSION_TOKEN: accessToken, ALIA_CANARY_SESSION_ID: sessionId } = env;
  if (!accessToken || !sessionId) return false;
  try {
    client.http.setTokens(accessToken);
    await client.session.logout(sessionId);
    return true;
  } finally {
    client.dispose();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const mode = process.argv[2];
  try {
    if (mode === 'open') {
      console.log(JSON.stringify(await openQaSession(process.env)));
    } else if (mode === 'close') {
      await closeQaSession(process.env);
    } else {
      throw new Error('usage: canary-qa-session.mjs open|close');
    }
  } catch (error) {
    // The message only: an SDK error may carry the request, and the request carries the bearer.
    console.error(`canary-qa-session: ${error instanceof Error ? error.message : 'failed'}`);
    process.exit(1);
  }
}
