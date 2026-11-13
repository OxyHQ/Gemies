import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Kaana } from '@kaana.ai/sdk';
import { OxyServer } from '@oxy.so/core/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ client: null as OxyServer | null }));
vi.mock('../../oxy.js', () => ({
  get oxy() {
    return H.client;
  },
}));
const { getKaanaClient, setKaanaClientForTests } = await import('../transport.js');
let issuer: Server;
let baseURL: string;
let mints: Record<string, unknown>[] = [];
const token = `e30.${Buffer.from(JSON.stringify({ authority: 'first_party', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.fixture`;

beforeAll(async () => {
  issuer = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/challenge')) return res.end(JSON.stringify({ nonce: 'fixture' }));
    let body = '';
    for await (const chunk of req) body += chunk;
    mints.push(JSON.parse(body));
    res.end(JSON.stringify({ token, expiresIn: 300 }));
  });
  await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      issuer.close((error) => (error ? reject(error) : resolve())),
    ),
);
beforeEach(() => {
  mints = [];
  setKaanaClientForTests(undefined);
  H.client = new OxyServer({
    baseURL,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'fixture',
      Token: 'temporary',
    }),
  });
});
afterEach(() => {
  H.client?.dispose();
  H.client = null;
  setKaanaClientForTests(undefined);
  vi.unstubAllGlobals();
});

describe('getKaanaClient', () => {
  it('keeps attribution per call and shares the real v2 workload mint across callers', async () => {
    const nativeFetch = globalThis.fetch;
    const observed: Array<{ account: string | null; authorization: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin !== 'https://kaana.ai') return nativeFetch(input, init);
        const headers = new Headers(init?.headers);
        observed.push({
          account: headers.get('x-oxy-user-id'),
          authorization: headers.get('authorization'),
        });
        return Response.json({ data: [] }, { headers: { 'Kaana-Request-Id': 'fixture-request' } });
      },
    );
    const a = getKaanaClient('A');
    const b = getKaanaClient('B');
    expect(a).toBeInstanceOf(Kaana);
    try {
      await a!.models.list({ onBehalfOfUserId: 'A' });
      await b!.models.list({ onBehalfOfUserId: 'B' });
      await expect(a!.models.list({ onBehalfOfUserId: 'B' })).rejects.toThrow();
      expect(observed).toEqual([
        { account: 'A', authorization: `Bearer ${token}` },
        { account: 'B', authorization: `Bearer ${token}` },
      ]);
      expect(mints).toHaveLength(1);
      expect(mints[0]).toMatchObject({ audience: 'kaana.ai', protocolVersion: 2 });
      expect(mints[0]).not.toHaveProperty('scopes');
      a!.dispose?.();
      await expect(a!.models.list()).rejects.toThrow();
    } finally {
      a?.dispose?.();
      b?.dispose?.();
    }
  });
});

const { getHostedKaanaClient, disposeHostedKaanaClient } = await import('../transport.js');
const { kaanaLanguageModel } = await import('../../inference/kaana-language-model.js');
const call = {
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'private prompt' }] }],
};
function model(accountId = 'A', serviceToken?: string) {
  return kaanaLanguageModel({
    target: { kind: 'routingProfile', routingProfile: 'auto' },
    modelId: 'auto',
    surface: 'chat',
    oxyUserId: accountId,
    serviceToken,
  });
}
function frame(type: string, sequence: number, body: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ schemaVersion: 1, type, sequence, requestId: 'req-direct', ...body })}\n\n`;
}
const startFrame = frame('start', 0, {
  model: 'fixture/model@1',
  startedAt: new Date().toISOString(),
});
function interceptKaana(handler: (init?: RequestInit) => Response | Promise<Response>) {
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== 'https://kaana.ai') return nativeFetch(input, init);
    expect(url.pathname).toBe('/v1/responses');
    return handler(init);
  });
}

describe('hosted text through the real Kaana SDK', () => {
  it('sends content and structured schema only to Kaana and binds account attribution immutably', async () => {
    const requests: Array<{ account: string | null; body: unknown }> = [];
    interceptKaana((init) => {
      requests.push({
        account: new Headers(init?.headers).get('x-oxy-user-id'),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(
        {
          schemaVersion: 1,
          requestId: 'req-direct',
          model: 'fixture/model@1',
          finishReason: 'stop',
          output: [{ role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }] }],
          usage: [
            { unit: 'input_tokens', quantity: 12 },
            { unit: 'output_tokens', quantity: 4 },
          ],
          routingPolicy: { routingPolicyId: 'fixture', policyVersion: 1 },
          latencyMs: 1,
        },
        { headers: { 'Kaana-Request-Id': 'req-direct' } },
      );
    });
    const result = await model().doGenerate({
      ...call,
      responseFormat: {
        type: 'json',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(result.providerMetadata).toEqual({
      kaana: { resolvedModelReference: 'fixture/model@1' },
    });
    expect(requests[0]).toMatchObject({
      account: 'A',
      body: { model: 'auto', input: call.prompt, responseFormat: { type: 'json_schema' } },
    });
    expect(JSON.stringify(mints)).not.toContain('private prompt');
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({ audience: 'kaana.ai', protocolVersion: 2 });
    const bound = getHostedKaanaClient('A');
    try {
      await expect(
        bound.responses.create({ model: 'auto', input: 'secret' }, { onBehalfOfUserId: 'B' }),
      ).rejects.toThrow();
    } finally {
      disposeHostedKaanaClient(bound);
    }
    expect(requests).toHaveLength(1);
  });

  it('keeps a verified external machine key as payer without minting workload identity', async () => {
    interceptKaana((init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oxy_sk_fixture');
      return Response.json(
        {
          schemaVersion: 1,
          requestId: 'req-external',
          code: 'insufficient_balance',
          message: 'No balance',
          retryable: false,
        },
        { status: 402, headers: { 'Kaana-Request-Id': 'req-external' } },
      );
    });
    await expect(model('A', 'oxy_sk_fixture').doGenerate(call)).rejects.toMatchObject({
      code: 'insufficient_balance',
      status: 402,
    });
    expect(mints).toHaveLength(0);
    expect(() => getHostedKaanaClient('A', 'audience-bound.jwt')).toThrow(
      'verified inference machine',
    );
  });

  it('preserves streamed tools, measured usage and served identity with one terminal failure', async () => {
    interceptKaana(
      () =>
        new Response(
          startFrame +
            frame('tool_call', 1, {
              toolCallId: 'tool-1',
              name: 'lookup',
              argumentsDelta: '{"q":',
              complete: false,
            }) +
            frame('tool_call', 2, {
              toolCallId: 'tool-1',
              argumentsDelta: '"ok"}',
              complete: true,
            }) +
            frame('usage', 3, {
              units: [
                { unit: 'input_tokens', quantity: 12 },
                { unit: 'output_tokens', quantity: 4 },
              ],
              usageSource: 'provider_reported',
            }) +
            frame('error', 4, {
              error: {
                schemaVersion: 1,
                requestId: 'req-direct',
                code: 'provider_error',
                message: 'Failed',
                retryable: true,
              },
            }),
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Kaana-Routing-Policy-Id': 'fixture',
              'Kaana-Routing-Policy-Version': '1',
              'Kaana-Request-Id': 'req-direct',
            },
          },
        ),
    );
    const chunks = [];
    for await (const chunk of (await model().doStream(call)).stream) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(1);
    expect(chunks).toContainEqual({
      type: 'tool-call',
      toolCallId: 'tool-1',
      toolName: 'lookup',
      input: '{"q":"ok"}',
    });
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: { unified: 'error', raw: 'provider_error' },
      usage: { inputTokens: { total: 12 }, outputTokens: { total: 4 } },
      providerMetadata: { kaana: { resolvedModelReference: 'fixture/model@1' } },
    });
  });

  it('cancels an active upstream body immediately when its consumer stops reading', async () => {
    let cancelled = false;
    interceptKaana(
      (init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(startFrame));
              init?.signal?.addEventListener(
                'abort',
                () => {
                  cancelled = true;
                  controller.error(init.signal?.reason);
                },
                { once: true },
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Kaana-Routing-Policy-Id': 'fixture',
              'Kaana-Routing-Policy-Version': '1',
              'Kaana-Request-Id': 'req-direct',
            },
          },
        ),
    );
    const reader = (await model().doStream(call)).stream.getReader();
    await reader.read();
    expect((await reader.read()).value).toMatchObject({ type: 'response-metadata' });
    await reader.cancel('person stopped');
    expect(cancelled).toBe(true);
  });

  it('does not multiply retries when Kaana returns a typed refusal', async () => {
    let requests = 0;
    interceptKaana(() => {
      requests++;
      return Response.json(
        {
          schemaVersion: 1,
          requestId: 'req-timeout',
          code: 'provider_timeout',
          message: 'Timed out',
          retryable: true,
        },
        { status: 504, headers: { 'Kaana-Request-Id': 'req-timeout' } },
      );
    });
    await expect(model().doGenerate(call)).rejects.toMatchObject({ code: 'provider_timeout' });
    expect(requests).toBe(1);
  });
});

it('settles a pending read with an error when the caller aborts, independently of reader.cancel', async () => {
  const abort = new AbortController();
  interceptKaana(
    (init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(startFrame));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Kaana-Request-Id': 'req-direct',
            'Kaana-Routing-Policy-Id': 'fixture',
            'Kaana-Routing-Policy-Version': '1',
          },
        },
      ),
  );
  const reader = (
    await model().doStream({ ...call, abortSignal: abort.signal })
  ).stream.getReader();
  await reader.read();
  expect((await reader.read()).value).toMatchObject({ type: 'response-metadata' });
  const pending = reader.read();
  abort.abort(new DOMException('Stopped', 'AbortError'));
  expect((await pending).value).toMatchObject({ type: 'error' });
  expect((await reader.read()).value).toMatchObject({
    type: 'finish',
    finishReason: { unified: 'error' },
  });
  expect((await reader.read()).done).toBe(true);
});

it('records a nonstream protocol failure request ID before throwing so late usage can reconcile', async () => {
  interceptKaana(() => Response.json({}, { headers: { 'Kaana-Request-Id': 'req-malformed' } }));
  const recorded = vi.fn();
  const adapter = kaanaLanguageModel({
    target: { kind: 'routingProfile', routingProfile: 'auto' },
    modelId: 'auto',
    surface: 'chat',
    oxyUserId: 'A',
    onInferenceRequest: recorded,
  });
  await expect(adapter.doGenerate(call)).rejects.toMatchObject({
    name: 'KaanaProtocolError',
    requestId: 'req-malformed',
  });
  expect(recorded).toHaveBeenCalledExactlyOnceWith({
    requestId: 'req-malformed',
    modelReference: null,
  });
});
