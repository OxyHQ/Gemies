import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DelegatedTurnEvent,
  DelegatedTurnFailure,
  type DelegatedTurnRequest,
  chatRouteTurnRunner,
} from '../delegated-turn.js';

/**
 * A delegated turn is the chat route's own turn (ADR 0041 §2): the request a
 * typed turn sends, over this process's loopback port, read back from the
 * route's SSE stream. Here against a real HTTP server standing in for
 * `/alia/chat` and `/v1/chat/turns/:id/cancel`.
 */

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function route(answer: (res: http.ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      };
      seen.push(entry);
      answer(res, entry);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    runner: chatRouteTurnRunner({ baseURL: `http://127.0.0.1:${port}` }),
    transport: chatRouteTurnRunner({ baseURL: `http://127.0.0.1:${port}`, identity: 'transport' }),
    seen,
  };
}

function sse(res: http.ServerResponse, frames: readonly string[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) res.write(frame);
  res.end();
}

const chunk = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ index: 0, delta }] })}\n\n`;

function request(overrides: Partial<DelegatedTurnRequest> = {}): DelegatedTurnRequest {
  return {
    accessToken: 'oxy-session',
    appAssertion: 'clarity-assertion',
    conversationId: 'conv-1',
    messages: [
      { id: 'm1', role: 'user', content: 'Antes' },
      { id: 'voice-u1', role: 'user', content: 'Recuérdame comprar pan' },
    ],
    assistantMessageId: 'voice-a1',
    turnId: '7d0b3a52-4f7e-4a3c-9f3e-2b1c0d9e8f7a',
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<DelegatedTurnEvent>) {
  const out: DelegatedTurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('the request is a typed turn’s', () => {
  it('posts the history, the person’s words and the voice response mode as the person, in the app', async () => {
    const { runner, seen } = await route((res) => sse(res, ['data: [DONE]\n\n']));
    await collect(runner.run(request({ agentId: 'gemie-7' })));
    expect(seen).toHaveLength(1);
    const [post] = seen;
    expect(post!.method).toBe('POST');
    expect(post!.url).toBe('/alia/chat');
    expect(post!.headers.authorization).toBe('Bearer oxy-session');
    expect(post!.headers['x-oxy-app-assertion']).toBe('clarity-assertion');
    expect(post!.headers.accept).toBe('text/event-stream');
    expect(post!.body).toEqual({
      turnId: '7d0b3a52-4f7e-4a3c-9f3e-2b1c0d9e8f7a',
      messages: [
        { id: 'm1', role: 'user', content: 'Antes' },
        { id: 'voice-u1', role: 'user', content: 'Recuérdame comprar pan' },
      ],
      assistantMessageId: 'voice-a1',
      conversationId: 'conv-1',
      agentId: 'gemie-7',
      stream: true,
      responseMode: 'voice',
    });
  });

  it('through a ready-made transport, presents nothing of its own and asks for no turn control', async () => {
    const { transport, seen } = await route((res) => sse(res, ['data: [DONE]\n\n']));
    await collect(transport.run(request()));
    await transport.cancel({
      accessToken: 'oxy-session',
      appAssertion: null,
      turnId: '7d0b3a52-4f7e-4a3c-9f3e-2b1c0d9e8f7a',
      conversationId: 'conv-1',
    });
    // One request: the turn. A channel identity has no turn control to cancel through.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers).not.toHaveProperty('authorization');
    expect(seen[0]!.headers).not.toHaveProperty('x-oxy-app-assertion');
    expect(seen[0]!.body).not.toHaveProperty('turnId');
    expect(seen[0]!.body).toMatchObject({ responseMode: 'voice', conversationId: 'conv-1' });
  });

  it('sends no assertion header when the call is in no app', async () => {
    const { runner, seen } = await route((res) => sse(res, ['data: [DONE]\n\n']));
    await collect(runner.run(request({ appAssertion: null })));
    expect(seen[0]!.headers).not.toHaveProperty('x-oxy-app-assertion');
    expect(seen[0]!.body).not.toHaveProperty('agentId');
  });
});

describe('the stream', () => {
  it('yields the answer’s words and the tools it ran, until [DONE]', async () => {
    const { runner } = await route((res) =>
      sse(res, [
        ': keep-alive\n\n',
        `event: alia.context\ndata: ${JSON.stringify({ eventVersion: 1 })}\n\n`,
        chunk({
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'createReminder' } },
          ],
        }),
        `event: alia.tool_result\ndata: ${JSON.stringify({ eventVersion: 1, tool_call_id: 'call_1', name: 'createReminder', output: { id: 'r1' } })}\n\n`,
        `event: alia.tool_result\ndata: ${JSON.stringify({ eventVersion: 1, tool_call_id: 'call_2', name: 'webSearch', output: { error: 'down' } })}\n\n`,
        chunk({ content: 'Hecho, ' }),
        chunk({ content: 'mañana.' }),
        chunk({ content: '' }),
        'data: [DONE]\n\n',
      ]),
    );
    expect(await collect(runner.run(request()))).toEqual([
      { type: 'tool.started', callId: 'call_1', name: 'createReminder' },
      { type: 'tool.finished', callId: 'call_1', name: 'createReminder', ok: true },
      { type: 'tool.finished', callId: 'call_2', name: 'webSearch', ok: false },
      { type: 'text', text: 'Hecho, ' },
      { type: 'text', text: 'mañana.' },
    ]);
  });

  it('a refusal before the stream is the route’s typed failure', async () => {
    const { runner } = await route((res) => {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INSUFFICIENT_CREDITS', message: 'no' } }));
    });
    await expect(collect(runner.run(request()))).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      status: 402,
    });
  });

  it('a failure on the open stream is typed too, even after words', async () => {
    const { runner } = await route((res) =>
      sse(res, [
        chunk({ content: 'Un mom' }),
        `data: ${JSON.stringify({ error: { message: 'busy', code: 'PROVIDER_UNAVAILABLE', retryable: true } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    const seen: DelegatedTurnEvent[] = [];
    const failure = await (async () => {
      try {
        for await (const event of runner.run(request())) seen.push(event);
      } catch (error) {
        return error;
      }
    })();
    expect(seen).toEqual([{ type: 'text', text: 'Un mom' }]);
    expect(failure).toBeInstanceOf(DelegatedTurnFailure);
    expect(failure).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a stream cut before [DONE] is a failure, never a finished answer', async () => {
    const { runner } = await route((res) => sse(res, [chunk({ content: 'Hola' })]));
    await expect(collect(runner.run(request()))).rejects.toMatchObject({ code: 'stream_cut' });
  });

  it('an aborted turn throws as aborted', async () => {
    const controller = new AbortController();
    const { runner } = await route((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: 'Hola' }));
      setTimeout(() => controller.abort(), 10);
    });
    await expect(collect(runner.run(request({ signal: controller.signal })))).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('stopping a turn', () => {
  it('cancels it the way the app’s Stop does, as the same person in the same app', async () => {
    const { runner, seen } = await route((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"state":"cancelled"}');
    });
    await runner.cancel({
      accessToken: 'oxy-session',
      appAssertion: 'clarity-assertion',
      turnId: '7d0b3a52-4f7e-4a3c-9f3e-2b1c0d9e8f7a',
      conversationId: 'conv-1',
    });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/turns/7d0b3a52-4f7e-4a3c-9f3e-2b1c0d9e8f7a/cancel',
      body: { conversationId: 'conv-1' },
    });
    expect(seen[0]!.headers.authorization).toBe('Bearer oxy-session');
    expect(seen[0]!.headers['x-oxy-app-assertion']).toBe('clarity-assertion');
  });
});
