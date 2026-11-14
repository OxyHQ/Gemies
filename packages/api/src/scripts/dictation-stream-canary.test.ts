import { describe, expect, it } from 'vitest';
import type { Model } from '@kaana.ai/contracts';
import { createFakeKaana, voiceCatalogue } from '@kaana.ai/sdk/testing';
import {
  CANARY_REFERENCE,
  type CanaryReport,
  canaryAccount,
  judge,
  judgeUpload,
  parseArgs,
  plan,
  recall,
  runCanary,
  runUploadCanary,
} from './dictation-stream-canary.js';

const batchLine = voiceCatalogue.find(
  (model) => model.modelId === 'x-ai/grok-voice-transcribe-2.0',
);
if (!batchLine) throw new Error('The fake catalogue has no xAI transcription line');
const streamingLine: Model = {
  ...batchLine,
  capabilities: {
    ...batchLine.capabilities,
    realtime: {
      transports: ['websocket'],
      sessionKinds: ['transcription'],
      inputAudioTranscription: false,
      audioFormats: { input: ['pcm16_24khz', 'g711_ulaw', 'g711_alaw'], output: [] },
    },
  },
};
const models = voiceCatalogue.map((model) =>
  model.modelId === streamingLine.modelId ? streamingLine : model,
);

const passing: CanaryReport = {
  mode: 'stream',
  model: 'x-ai/grok-voice-transcribe-2.0',
  sessionId: 'req_1',
  audioMs: 60_000,
  wallMs: 63_000,
  counts: { interim: 12, delta: 6, done: 3, errors: 0 },
  firstInterimMs: 800,
  finalText: `This is a LibriVox recording. ${CANARY_REFERENCE}.`,
  recall: 1,
  billedSessionMs: 62_500,
  units: [{ unit: 'session_milliseconds', quantity: 62_500 }],
  fatal: null,
};

describe('dictation stream canary', () => {
  it('passes a complete session and fails each missing piece (negative controls)', () => {
    expect(judge(passing)).toEqual([]);
    expect(judge({ ...passing, counts: { ...passing.counts, interim: 0 } })).toEqual([
      'no transcript.interim',
    ]);
    expect(judge({ ...passing, counts: { ...passing.counts, delta: 0 } })).toEqual([
      'no transcript.delta',
    ]);
    expect(judge({ ...passing, counts: { ...passing.counts, done: 0 } })).toEqual([
      'no transcript.done',
    ]);
    expect(judge({ ...passing, fatal: 'provider_error' })).toEqual(['fatal: provider_error']);
    expect(judge({ ...passing, recall: 0.5 })[0]).toMatch(/recall/);
    expect(judge({ ...passing, billedSessionMs: null })).toEqual([
      'no session_milliseconds billed',
    ]);
    expect(judge({ ...passing, billedSessionMs: 30_000 })[0]).toMatch(/< the 60000 ms of audio/);
    expect(judge({ ...passing, billedSessionMs: 90_000 })[0]).toMatch(/> wall clock/);
  });

  it('measures recall in order and ignores case and punctuation', () => {
    expect(recall('Four score and seven', 'four, SCORE and seven!')).toBe(1);
    expect(recall('four score and seven', 'seven and score four')).toBeLessThan(0.5);
    expect(
      recall(CANARY_REFERENCE, `${CANARY_REFERENCE.replace('on this', 'upon this')}`),
    ).toBeGreaterThan(0.9);
  });

  it('refuses to run without the QA account and the explicit confirmation', () => {
    expect(() => canaryAccount({})).toThrow(/CONFIRM/);
    expect(() =>
      canaryAccount({ ALIA_DICTATION_CANARY_CONFIRM: 'production-dictation-canary' }),
    ).toThrow(/ALIA_CANARY_OXY_USER_ID/);
    expect(
      canaryAccount({
        ALIA_DICTATION_CANARY_CONFIRM: 'production-dictation-canary',
        ALIA_CANARY_OXY_USER_ID: '0123456789abcdef01234567',
      }),
    ).toBe('0123456789abcdef01234567');
  });

  it('parses its flags and prints the plan on a dry run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(() => parseArgs(['--seconds', '5'])).toThrow();
    expect(() => parseArgs(['--audio-file', 'x.wav'])).toThrow(/--reference/);
    expect(parseArgs([]).mode).toBe('upload');
    expect(parseArgs(['--mode', 'stream']).mode).toBe('stream');
    expect(() => parseArgs(['--mode', 'batch'])).toThrow(/--mode/);
    expect(plan(parseArgs([]))).toMatch(/POST \/v1\/audio\/transcriptions/);
    expect(plan(parseArgs(['--mode', 'stream']))).toMatch(/interimResults/);
  });

  it('opens a transcription session exactly as dictation does and reads back the billed units', async () => {
    const fake = createFakeKaana({ models });
    const pcm = new Uint8Array(48 * 1_000);
    const running = runCanary(parseArgs(['--mode', 'stream']), pcm, {
      kaana: fake.kaana,
      account: 'user-1',
      frameDelayMs: 0,
      finalWaitMs: 2_000,
    });
    while (fake.server.sessions.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const session = fake.server.sessions[0];
    if (!session) throw new Error('no session');
    session.emit({
      type: 'transcript.interim',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      text: 'four sc',
    });
    session.emit({
      type: 'transcript.delta',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      text: 'Four score ',
    });
    while (!session.commands.some((command) => command.type === 'input_audio.commit'))
      await new Promise((resolve) => setTimeout(resolve, 5));
    session.emit({
      type: 'transcript.done',
      source: 'input_audio',
      itemId: 'item_1',
      contentIndex: 0,
      transcript: CANARY_REFERENCE,
    });
    const report = await running;
    expect(session.open).toMatchObject({
      kind: 'transcription',
      config: {
        inputAudioFormat: 'pcm16_24khz',
        inputAudioTranscription: { language: 'en', interimResults: true },
      },
    });
    expect(report.counts).toMatchObject({ interim: 1, delta: 1, done: 1, errors: 0 });
    expect(report.recall).toBe(1);
    expect(report.audioMs).toBe(1_000);
    expect(judge(report)).toEqual(['no session_milliseconds billed']);
  });

  it("uploads one WAV clip through the dictation route's own transcription", async () => {
    const uploads: { mediaType: string; language?: string; bytes: number; model: string }[] = [];
    const fake = createFakeKaana({
      models: voiceCatalogue,
      transcribe: (upload) => {
        uploads.push({
          mediaType: upload.mediaType,
          bytes: upload.audio.byteLength,
          model: upload.model.modelId,
          ...(upload.language === undefined ? {} : { language: upload.language }),
        });
        return { text: `This is a LibriVox recording. ${CANARY_REFERENCE}.`, durationMs: 20_000 };
      },
    });
    const wav = new Uint8Array(4_096).fill(1);
    const report = await runUploadCanary(parseArgs(['--seconds', '20']), wav, {
      kaana: fake.kaana,
      account: 'user-1',
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ mediaType: 'audio/wav', language: 'en', bytes: 4_096 });
    expect(report).toMatchObject({ mode: 'upload', audioMs: 20_000, recall: 1, fatal: null });
    expect(report.model.startsWith(`${uploads[0]?.model}@`)).toBe(true);
    expect(judgeUpload(report)).toEqual([]);
  });

  it('fails an upload that no model served or that lost the words (negative controls)', () => {
    const ok = {
      mode: 'upload' as const,
      model: 'x-ai/grok-voice-transcribe-2.0',
      audioMs: 20_000,
      wallMs: 2_000,
      finalText: CANARY_REFERENCE,
      recall: 1,
      fatal: null,
    };
    expect(judgeUpload(ok)).toEqual([]);
    expect(
      judgeUpload({ ...ok, fatal: 'TRANSCRIPTION_UNAVAILABLE', model: '', recall: 0 }),
    ).toEqual(['fatal: TRANSCRIPTION_UNAVAILABLE', 'final text recall 0.00 < 0.8']);
    expect(judgeUpload({ ...ok, model: '' })).toEqual(['no model served the clip']);
    expect(judgeUpload({ ...ok, recall: 0.5 })).toEqual(['final text recall 0.50 < 0.8']);
  });
});
