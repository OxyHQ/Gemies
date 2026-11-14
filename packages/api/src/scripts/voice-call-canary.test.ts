import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});
// The socket's default environment is never built here: the server gets the harness's.
vi.mock('../lib/voice/environment.js', () => ({ createVoiceEnvironment: vi.fn() }));
vi.mock('../lib/socket-session-auth.js', () => ({ authenticateSocketSession: vi.fn() }));
vi.mock('../lib/app-surface.js', () => ({ verifySurface: vi.fn(async () => null) }));

const {
  canaryIdentity,
  FIXTURE,
  judgeVoice,
  parseVoiceArgs,
  reminderIdsOf,
  runVoiceCanary,
  voicePlan,
} = await import('./voice-call-canary.js');
const { voiceSessionRoute } = await import('../lib/voice/voice-socket.js');
const { routeWebSocketUpgrades } = await import('../lib/websocket-upgrades.js');
const { harness, LIVE_DEFAULT, pcmBase64, until, withTool } = await import(
  '../lib/voice/__tests__/support.js'
);

/**
 * The production voice canary (ADR 0041 §7) end to end: the canary's own
 * client against the real voice socket, served by the production `VoiceCall`
 * over `@kaana.ai/sdk/testing`'s `live` session and a scripted chat route, and
 * the app routes it cleans up through.
 */

const QA = '0123456789abcdef01234567';

function passing() {
  return {
    callId: 'vc_1',
    model: 'test-voice/live-default@1',
    audioMs: 4_200,
    answeredTurns: 1,
    tools: [{ name: 'createAutomation', ok: true }],
    audioBytes: 9_600,
    answerAudioBytes: 4_800,
    firstAnswerAudioMs: 1_800,
    closedReason: 'hangup',
    errors: [],
    reminderStopped: true,
    conversationRemoved: true,
    wallMs: 12_000,
  };
}

describe('the judgement', () => {
  it('passes a call that answered one turn with the tool, spoke it, closed and cleaned up', () => {
    expect(judgeVoice(passing())).toEqual([]);
  });

  it.each([
    [{ model: null }, 'the call was never ready'],
    [{ answeredTurns: 0 }, '0 turns answered and stored, not exactly one'],
    [{ answeredTurns: 2 }, '2 turns answered and stored, not exactly one'],
    [{ tools: [{ name: 'createAutomation', ok: false }] }, 'did not run createAutomation'],
    [{ tools: [{ name: 'webSearch', ok: true }] }, 'did not run createAutomation'],
    [{ audioBytes: 0, answerAudioBytes: 0 }, 'no audio came back'],
    [{ answerAudioBytes: 0 }, 'the answer was not spoken'],
    [{ closedReason: 'error' }, 'closed error'],
    [{ closedReason: null }, 'closed never'],
    [{ reminderStopped: false }, 'the reminder was not stopped'],
    [{ errors: ['realtime-unavailable'] }, 'call errors: realtime-unavailable'],
  ])('fails %o', (change, failure) => {
    expect(judgeVoice({ ...passing(), ...change }).join('\n')).toContain(failure);
  });
});

describe('the options and the identity', () => {
  it('takes the voice and the locale, and a dry run names no model', () => {
    expect(parseVoiceArgs([])).toEqual({ dryRun: false, voice: 'female', locale: 'en-US' });
    expect(parseVoiceArgs(['--voice', 'male', '--locale', 'en-GB', '--dry-run'])).toEqual({
      dryRun: true,
      voice: 'male',
      locale: 'en-GB',
    });
    expect(() => parseVoiceArgs(['--voice', 'alloy'])).toThrow('--voice');
    expect(() => parseVoiceArgs(['--locale', 'not a tag'])).toThrow('--locale');
    expect(voicePlan(parseVoiceArgs([]))).not.toMatch(/gpt|grok|openai|x-ai/i);
  });

  it('needs the explicit confirmation and the QA session opened for this run', () => {
    const session = {
      ALIA_CANARY_OXY_USER_ID: QA,
      ALIA_CANARY_SESSION_TOKEN: 'qa-session',
      ALIA_CANARY_DEVICE_ID: 'device',
      ALIA_CANARY_DEVICE_SECRET: 'secret',
    };
    expect(() => canaryIdentity(session)).toThrow('ALIA_VOICE_CANARY_CONFIRM');
    const confirm = { ALIA_VOICE_CANARY_CONFIRM: 'production-voice-canary' };
    expect(() => canaryIdentity({ ...confirm, ...session, ALIA_CANARY_SESSION_TOKEN: '' })).toThrow(
      'ALIA_CANARY_SESSION_TOKEN',
    );
    expect(canaryIdentity({ ...confirm, ...session })).toMatchObject({
      accountId: QA,
      accessToken: 'qa-session',
    });
  });
});

describe('the recorded request', () => {
  it('is 24 kHz PCM16 mono speech of a few seconds', () => {
    const pcm = readFileSync(FIXTURE);
    expect(pcm.byteLength % 2).toBe(0);
    const seconds = pcm.byteLength / 48_000;
    expect(seconds).toBeGreaterThan(2);
    expect(seconds).toBeLessThan(10);
    // Not silence: the samples move.
    let peak = 0;
    for (let index = 0; index < pcm.byteLength; index += 2)
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(index)));
    expect(peak).toBeGreaterThan(2_000);
  });

  it('the reminders are read from the stored answers’ createAutomation results', () => {
    expect(
      reminderIdsOf([
        { toolInvocations: [{ toolName: 'webSearch', result: { automation: { id: 'x' } } }] },
        {
          toolInvocations: [
            { toolName: 'createAutomation', result: { success: true, automation: { id: 'a1' } } },
            { toolName: 'createAutomation', result: { success: false, error: 'too_many' } },
          ],
        },
      ]),
    ).toEqual(['a1']);
  });
});

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** The live image's API, as the canary reaches it: the voice socket and the app routes it cleans up through. */
async function api(h: ReturnType<typeof harness>) {
  const seen: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
    });
    if (req.method === 'GET' && req.url?.startsWith('/conversations/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // What the chat route stored, with the tool result `saveConversation` keeps.
      res.end(
        JSON.stringify({
          messages: h.stored.map((message) =>
            message.role === 'assistant'
              ? {
                  ...message,
                  toolInvocations: [
                    {
                      toolName: 'createAutomation',
                      state: 'result',
                      result: { success: true, automation: { id: 'auto-1' } },
                    },
                  ],
                }
              : message,
          ),
        }),
      );
      return;
    }
    res.writeHead(req.method === 'DELETE' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  servers.push(server);
  routeWebSocketUpgrades(server, {
    socketIoPath: '/socket.io',
    routes: [
      voiceSessionRoute(undefined, {
        environment: () => h.env,
        authenticate: async (token) =>
          token === 'qa-session' ? { userId: 'user-1', sessionId: 'session-1' } : null,
      }),
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, seen };
}

describe('the run', () => {
  it('calls through the socket, gets a tool-calling answer spoken, hangs up and cleans up', async () => {
    const h = harness();
    h.turns.answer(withTool('createAutomation', true, 'Done. ', 'I will remind you at nine.'));
    const { baseURL, seen } = await api(h);
    // A short request: ten frames of the recording.
    const pcm = new Uint8Array(readFileSync(FIXTURE).subarray(0, 19_200));

    const running = runVoiceCanary(parseVoiceArgs([]), pcm, {
      baseURL,
      bearer: async () => 'qa-session',
      frameDelayMs: 0,
      quietAfterAnswerMs: 30,
      timeoutMs: 5_000,
    });

    // The voice hears the request, hands the turn over and speaks the answer.
    await until(
      'request streamed',
      () => h.server.sessions.length === 1 && h.commands('input_audio.append').length >= 10,
    );
    h.session().emit({
      type: 'delegation.requested',
      delegationId: 'd1',
      text: 'Remind me to water the plants tomorrow at nine.',
    });
    await until('answer', () => h.commands('delegation.reply').some((reply) => reply.final));
    await until('stored', () => h.stored.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.session().emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'out_1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });

    const report = await running;
    expect(judgeVoice(report)).toEqual([]);
    expect(report).toMatchObject({
      callId: expect.stringMatching(/^vc_/),
      model: `${LIVE_DEFAULT.modelId}@${LIVE_DEFAULT.currentRevision}`,
      answeredTurns: 1,
      tools: [{ name: 'createAutomation', ok: true }],
      answerAudioBytes: 40 * 48,
      closedReason: 'hangup',
      reminderStopped: true,
      conversationRemoved: true,
    });
    // The call ran as the QA person, in the conversation it then cleaned up.
    expect(h.session().open.kind).toBe('live');
    expect(h.turns.requests[0]!.accessToken).toBe('qa-session');
    const conversationId = h.turns.requests[0]!.conversationId;
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /conversations/${conversationId}`,
      'DELETE /automations/auto-1',
      `DELETE /conversations/${conversationId}`,
    ]);
    expect(seen.every((request) => request.authorization === 'Bearer qa-session')).toBe(true);
    expect(h.session().closed).toBe(true);
  });

  it('a call the plan refuses fails typed, and still removes its conversation', async () => {
    const h = harness({ voiceMode: false });
    const { baseURL, seen } = await api(h);
    const report = await runVoiceCanary(parseVoiceArgs([]), new Uint8Array(1_920), {
      baseURL,
      bearer: async () => 'qa-session',
      frameDelayMs: 0,
      timeoutMs: 2_000,
    });
    expect(judgeVoice(report)).toEqual(
      expect.arrayContaining(['the call was never ready', 'call errors: plan-required']),
    );
    expect(seen.at(-1)?.method).toBe('DELETE');
  });
});
