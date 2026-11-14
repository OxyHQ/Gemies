import type { Model } from '@kaana.ai/contracts';
import { voiceCatalogue } from '@kaana.ai/sdk/testing';
import { describe, expect, it } from 'vitest';
import {
  liveVoiceLines,
  rankTranscriptionCandidates,
  rankTranscriptionSessionCandidates,
  usdPerMinute,
} from '../voice-models.js';

/**
 * Voice and dictation models chosen from Kaana's own catalogue (the one
 * `@kaana.ai/sdk/testing` serves), never by language — Kaana gives every model
 * the language: a call by the catalogue's default `live` line, dictation by
 * the published price per minute.
 */

const realtime = voiceCatalogue.find((model) => model.capabilities.realtime)!;
const transcription = voiceCatalogue.filter((model) =>
  model.capabilities.apiFormats?.includes('audio_transcriptions'),
);

function priced(model: Model, modelId: string, amount: string | undefined): Model {
  return {
    ...model,
    modelId,
    ...(amount === undefined
      ? { pricePerMinute: undefined }
      : { pricePerMinute: { amount, currency: 'USD' } }),
  } as Model;
}

describe('usdPerMinute', () => {
  it("reads the catalogue's price per minute in USD, and nothing else", () => {
    expect(usdPerMinute(priced(realtime, 'a/b', '0.08'))).toBe(0.08);
    expect(usdPerMinute(priced(realtime, 'a/b', undefined))).toBeNull();
    expect(
      usdPerMinute({ ...realtime, pricePerMinute: { amount: '0.08', currency: 'EUR' } } as Model),
    ).toBeNull();
  });
});

/** A `live` line built from Kaana's realtime line, the default of the kind when asked. */
function live(modelId: string, options: { isDefault?: boolean; amount?: string } = {}): Model {
  const capabilities = realtime.capabilities.realtime!;
  return {
    ...priced(realtime, modelId, options.amount ?? '0.05'),
    capabilities: {
      ...realtime.capabilities,
      realtime: {
        ...capabilities,
        sessionKinds: ['live'],
        ...(options.isDefault ? { defaultKinds: ['live'] } : {}),
      },
    },
  } as Model;
}

describe('liveVoiceLines', () => {
  it("opens on the catalogue's default live line first, whatever its price or place", () => {
    const lines = liveVoiceLines(
      [
        live('x/cheap', { amount: '0.01' }),
        realtime,
        live('x/default', { isDefault: true, amount: '0.5' }),
        live('x/other', { amount: '0.02' }),
      ],
      { voice: 'female' },
    );
    // Then the other live lines, in the catalogue's own order: never ranked by price.
    expect(lines.map((line) => line.model.modelId)).toEqual(['x/default', 'x/cheap', 'x/other']);
    expect(lines[0]!.usdPerMinute).toBe(0.5);
  });

  it("speaks in the line's catalogue voice of the product's gender", () => {
    for (const gender of ['female', 'male'] as const) {
      const [line] = liveVoiceLines([live('x/default', { isDefault: true })], { voice: gender });
      expect(realtime.audio!.voices.find((voice) => voice.id === line?.voiceId)?.gender).toBe(
        gender,
      );
    }
  });

  it('never a line that holds no live call, is not active, or has no voice of the gender', () => {
    const retired = { ...live('x/retired'), deprecation: { status: 'retired' } } as Model;
    const noVoice = {
      ...live('x/no-male', { isDefault: true }),
      audio: {
        ...realtime.audio!,
        voices: realtime.audio!.voices.filter((v) => v.gender !== 'male'),
      },
    } as Model;
    const alaw = {
      ...live('x/alaw'),
      capabilities: {
        ...realtime.capabilities,
        realtime: {
          ...realtime.capabilities.realtime!,
          sessionKinds: ['live'],
          audioFormats: { input: ['g711_alaw'], output: ['g711_alaw'] },
        },
      },
    } as Model;
    // Kaana's `conversation` line and its dictation lines hold no live call.
    expect(liveVoiceLines(voiceCatalogue, { voice: 'female' })).toEqual([]);
    expect(liveVoiceLines([retired, alaw, ...transcription], { voice: 'female' })).toEqual([]);
    expect(liveVoiceLines([noVoice], { voice: 'male' })).toEqual([]);
  });
});

describe('rankTranscriptionCandidates', () => {
  it("offers every model that takes the clip's media type, cheapest minute first", () => {
    const ranked = rankTranscriptionCandidates(voiceCatalogue, { mediaType: 'audio/webm' });
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual(
      [...transcription]
        .sort((a, b) => Number(a.pricePerMinute!.amount) - Number(b.pricePerMinute!.amount))
        .map((model) => model.modelId),
    );
    expect(ranked.length).toBeGreaterThan(1);
  });

  it('never offers a model that does not take the media type', () => {
    const ranked = rankTranscriptionCandidates(voiceCatalogue, { mediaType: 'audio/pcm' });
    for (const candidate of ranked)
      expect(candidate.model.audio!.audioFormats.input).toContain('audio/pcm');
  });
});

describe('rankTranscriptionSessionCandidates', () => {
  const sessionLine = (modelId: string, amount: string, input: string[] = ['pcm16_24khz']): Model =>
    priced(
      {
        ...transcription[0]!,
        capabilities: {
          ...transcription[0]!.capabilities,
          realtime: {
            transports: ['websocket'],
            sessionKinds: ['transcription'],
            inputAudioTranscription: false,
            audioFormats: { input, output: [] },
          },
        },
      } as Model,
      modelId,
      amount,
    );

  it('holds only lines that hold a transcription session, cheapest minute first', () => {
    const ranked = rankTranscriptionSessionCandidates([
      realtime,
      ...transcription,
      sessionLine('x/dear', '0.01'),
      sessionLine('x/cheap', '0.003'),
    ]);
    expect(ranked.map((candidate) => candidate.model.modelId)).toEqual(['x/cheap', 'x/dear']);
  });

  it('never a line that does not take 24 kHz PCM16, and none from a batch-only catalogue', () => {
    expect(
      rankTranscriptionSessionCandidates([sessionLine('x/ulaw', '0.001', ['g711_ulaw'])]),
    ).toEqual([]);
    expect(rankTranscriptionSessionCandidates(voiceCatalogue)).toEqual([]);
  });

  it('never a deprecated line', () => {
    const retired = {
      ...sessionLine('x/old', '0.001'),
      deprecation: { status: 'retired' },
    } as unknown as Model;
    expect(rankTranscriptionSessionCandidates([retired])).toEqual([]);
  });
});
