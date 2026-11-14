import { describe, expect, it } from 'vitest';
import { createFakeKaana, voiceCatalogue } from '@kaana.ai/sdk/testing';
import { rankRealtimeCandidates } from '../lib/models/voice-models.js';
import {
  canaryAccount,
  judgeVoice,
  parseVoiceArgs,
  runVoiceCanary,
  type VoiceCanaryReport,
  voicePlan,
} from './voice-call-canary.js';

const passing: VoiceCanaryReport = {
  model: 'x-ai/grok-voice-3.0',
  sessionId: 'req_1',
  audioMs: 8_000,
  wallMs: 14_000,
  counts: { responsesCreated: 1, responsesDone: 1, audioDeltas: 12, errors: 0 },
  firstAudioMs: 900,
  units: [{ unit: 'session_milliseconds', quantity: 12_000 }],
  fatal: null,
};

describe('voice call canary', () => {
  it('passes a complete call and fails each missing piece (negative controls)', () => {
    expect(judgeVoice(passing)).toEqual([]);
    expect(judgeVoice({ ...passing, sessionId: null })).toEqual(['no session opened']);
    expect(judgeVoice({ ...passing, counts: { ...passing.counts, responsesCreated: 0 } })).toEqual([
      'no response.created',
    ]);
    expect(judgeVoice({ ...passing, counts: { ...passing.counts, audioDeltas: 0 } })).toEqual([
      'no output_audio.delta',
    ]);
    expect(judgeVoice({ ...passing, counts: { ...passing.counts, responsesDone: 0 } })).toEqual([
      'no response.done',
    ]);
    expect(judgeVoice({ ...passing, units: [] })).toEqual(['no units billed']);
    expect(judgeVoice({ ...passing, fatal: 'policy_violation' })).toEqual([
      'fatal: policy_violation',
    ]);
  });

  it('refuses to run without the QA account and the explicit confirmation', () => {
    expect(() => canaryAccount({})).toThrow(/ALIA_VOICE_CANARY_CONFIRM/);
    expect(() => canaryAccount({ ALIA_VOICE_CANARY_CONFIRM: 'production-voice-canary' })).toThrow(
      /ALIA_CANARY_OXY_USER_ID/,
    );
    expect(
      canaryAccount({
        ALIA_VOICE_CANARY_CONFIRM: 'production-voice-canary',
        ALIA_CANARY_OXY_USER_ID: '0123456789abcdef01234567',
      }),
    ).toBe('0123456789abcdef01234567');
  });

  it('parses its flags and prints the plan on a dry run', () => {
    expect(parseVoiceArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseVoiceArgs([])).toMatchObject({ seconds: 8, voice: 'female', locale: 'en' });
    expect(() => parseVoiceArgs(['--seconds', '2'])).toThrow();
    expect(() => parseVoiceArgs(['--voice', 'robot'])).toThrow(/--voice/);
    expect(voicePlan(parseVoiceArgs([]))).toMatch(/server_vad/);
  });

  it('opens a conversation as a call does and reads back the answer and billed units', async () => {
    const fake = createFakeKaana({ models: voiceCatalogue });
    const pcm = new Uint8Array(48 * 1_000);
    const running = runVoiceCanary(parseVoiceArgs([]), pcm, {
      kaana: fake.kaana,
      account: 'user-1',
      frameDelayMs: 0,
      answerWaitMs: 2_000,
    });
    while (fake.server.sessions.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const session = fake.server.sessions[0];
    if (!session) throw new Error('no session');
    expect(session.open).toMatchObject({
      kind: 'conversation',
      config: {
        outputModalities: ['audio'],
        inputAudioFormat: 'pcm16_24khz',
        turnDetection: { type: 'server_vad', createResponse: true },
        inputAudioTranscription: { language: 'en' },
      },
    });
    session.emit({ type: 'response.created', responseId: 'resp_1' });
    session.emit({
      type: 'output_audio.delta',
      responseId: 'resp_1',
      itemId: 'item_1',
      contentIndex: 0,
      format: 'pcm16_24khz',
      data: Buffer.alloc(480).toString('base64'),
    });
    session.emit({
      type: 'response.done',
      responseId: 'resp_1',
      status: 'completed',
      units: [],
      usageSource: 'provider_reported',
    });
    const report = await running;
    expect(report.sessionId).not.toBeNull();
    expect(report.counts).toMatchObject({ responsesCreated: 1, audioDeltas: 1, responsesDone: 1 });
    expect(report.model).toBe(
      rankRealtimeCandidates(voiceCatalogue, { voice: 'female' })[0]?.model.modelId,
    );
  });
});
