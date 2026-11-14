import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});

const { canaryIdentity, FIXTURE, judge, reminderIdsOf, runVoiceCanary } = await import(
  './production-voice-canary.js'
);
const { VoiceCall, VOICE_CALL_LIMITS } = await import('../lib/voice/call.js');
const { harness, LIVE_DEFAULT, pcmBase64, until, withTool } = await import(
  '../lib/voice/__tests__/support.js'
);

/**
 * The production voice canary (ADR 0041 §7), run end to end against
 * `@kaana.ai/sdk/testing` and a scripted chat route: the production
 * `VoiceCall`, observed for its settlements, a reminder asked for, answered by
 * a turn that called the tool, spoken, hung up and cleaned up.
 */

const QA = '0123456789abcdef01234567';

function passing() {
  return {
    callId: 'vc_1',
    kaanaSessionId: 'rs_1',
    kaanaRequestId: 'req_1',
    model: 'test-voice/live-default@1',
    audioMs: 4_200,
    delegatedTurns: 1,
    answeredTurns: 1,
    tools: [{ name: 'createAutomation', ok: true }],
    audioBytes: 9_600,
    answerAudioBytes: 4_800,
    closedReason: 'hangup',
    errors: [],
    kaanaUnits: [{ unit: 'session_milliseconds', quantity: 9_000 }],
    creditsCharged: 3,
    callRowEnd: 'hangup',
    reminderStopped: true,
    wallMs: 12_000,
  };
}

describe('the judgement', () => {
  it('passes a call that answered one turn with the tool, spoke it and settled', () => {
    expect(judge(passing())).toEqual([]);
  });

  it.each([
    [{ model: null }, 'no live session was created'],
    [{ answeredTurns: 2 }, '2 turns answered and stored, not exactly one'],
    [{ tools: [{ name: 'createAutomation', ok: false }] }, 'did not call createAutomation'],
    [{ tools: [{ name: 'webSearch', ok: true }] }, 'did not call createAutomation'],
    [{ answerAudioBytes: 0 }, 'the answer was not spoken'],
    [{ kaanaUnits: null }, 'returned no usage'],
    [{ creditsCharged: null }, 'minutes were not charged'],
    [{ callRowEnd: null }, 'voice_calls row open'],
    [{ reminderStopped: false }, 'the reminder was not stopped'],
    [{ errors: ['realtime-failed'] }, 'call errors: realtime-failed'],
  ])('fails %o', (change, failure) => {
    expect(judge({ ...passing(), ...change }).join('\n')).toContain(failure);
  });
});

describe('the identity', () => {
  it('needs the explicit confirmation and one exact QA account with its task', () => {
    expect(() => canaryIdentity({})).toThrow('ALIA_VOICE_CANARY_CONFIRM');
    const confirm = { ALIA_VOICE_CANARY_CONFIRM: 'production-voice-canary' };
    expect(() => canaryIdentity({ ...confirm, ALIA_CANARY_OXY_USER_ID: 'anyone' })).toThrow(
      'ALIA_CANARY_OXY_USER_ID',
    );
    expect(() => canaryIdentity({ ...confirm, ALIA_CANARY_OXY_USER_ID: QA })).toThrow(
      'ALIA_CANARY_OXY_TASK_ID',
    );
    expect(
      canaryIdentity({
        ...confirm,
        ALIA_CANARY_OXY_USER_ID: QA,
        ALIA_CANARY_OXY_TASK_ID: 'task_1',
      }),
    ).toEqual({ accountId: QA, taskId: 'task_1' });
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
});

describe('the run', () => {
  it('reads the reminder ids a stored answer created', () => {
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

  it('calls, speaks, gets the tool-calling answer spoken, hangs up, settles and cleans up', async () => {
    const h = harness();
    h.turns.answer(withTool('createAutomation', true, 'Done. ', 'I will remind you at nine.'));
    const stopped: string[] = [];
    const removed: string[] = [];
    // A short request: ten frames of the recording.
    const pcm = new Uint8Array(readFileSync(FIXTURE).subarray(0, 19_200));

    const running = runVoiceCanary(pcm, {
      env: { ...h.env, credits: h.env.credits! },
      newCall: (env) => new VoiceCall(env, 'user-1', '', VOICE_CALL_LIMITS),
      stopReminder: async (conversationId) => {
        stopped.push(conversationId);
        return true;
      },
      removeConversation: async (conversationId) => {
        removed.push(conversationId);
      },
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.session().emit({
      type: 'output_audio.delta',
      responseId: 'r1',
      itemId: 'out_1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: pcmBase64(40),
    });

    const report = await running;
    expect(judge(report)).toEqual([]);
    expect(report).toMatchObject({
      model: `${LIVE_DEFAULT.modelId}@${LIVE_DEFAULT.currentRevision}`,
      kaanaSessionId: expect.any(String),
      kaanaRequestId: h.session().requestId,
      delegatedTurns: 1,
      answeredTurns: 1,
      tools: [{ name: 'createAutomation', ok: true }],
      closedReason: 'hangup',
      callRowEnd: 'hangup',
      reminderStopped: true,
    });
    expect(report.answerAudioBytes).toBe(40 * 48);
    expect(h.session().closed).toBe(true);
    // The canary's conversation is the one cleaned up, once.
    expect(stopped).toHaveLength(1);
    expect(removed).toEqual(stopped);
    expect(h.turns.requests[0]!.conversationId).toBe(stopped[0]);
  });

  it('a call that never opens fails typed and still cleans up', async () => {
    const h = harness({ voiceMode: false });
    const removed: string[] = [];
    const report = await runVoiceCanary(new Uint8Array(1_920), {
      env: { ...h.env, credits: h.env.credits! },
      newCall: (env) => new VoiceCall(env, 'user-1', '', VOICE_CALL_LIMITS),
      stopReminder: async () => false,
      removeConversation: async (conversationId) => {
        removed.push(conversationId);
      },
      frameDelayMs: 0,
      timeoutMs: 1_000,
    });
    expect(judge(report)).toEqual(
      expect.arrayContaining(['no live session was created', 'call errors: plan-required']),
    );
    expect(removed).toHaveLength(1);
  });
});
