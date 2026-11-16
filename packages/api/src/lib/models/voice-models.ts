/**
 * The voice and dictation models, computed from Kaana's catalogue (ADR 0017
 * §7, ADR 0041 §1). No model id is written anywhere: a model is a candidate
 * because of what the catalogue says it can do. A call opens on the
 * catalogue's default `live` line; dictation takes the cheapest minute.
 *
 * Kaana's API is one canonical contract (Kaana ADR 0003): it translates every
 * value the contract offers for every model, a language included, so a model
 * is chosen by product capability and price alone. The person's locale is
 * passed as it is; no model is excluded for its language.
 *
 * The person's power level never picks these models: realtime and
 * transcription models carry no power class. A call's answers are typed turns
 * (ADR 0041 §2), and those follow the person's level like any other.
 */

import type { AudioInputMediaType, Model } from '@kaana.ai/contracts';
import type { ProductVoice } from '../voice/protocol.js';

/** The model's published price of one minute in USD, or `null` when it states none in USD. */
export function usdPerMinute(model: Model): number | null {
  const price = model.pricePerMinute;
  if (!price || price.currency !== 'USD') return null;
  const amount = Number(price.amount);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/** Cheapest first; a model with no USD price after every priced one; then the id. */
function byPriceThenId(
  a: { readonly model: Model; readonly usdPerMinute: number | null },
  b: { readonly model: Model; readonly usdPerMinute: number | null },
): number {
  if (a.usdPerMinute !== null && b.usdPerMinute !== null && a.usdPerMinute !== b.usdPerMinute)
    return a.usdPerMinute - b.usdPerMinute;
  if (a.usdPerMinute === null && b.usdPerMinute !== null) return 1;
  if (a.usdPerMinute !== null && b.usdPerMinute === null) return -1;
  if (a.model.modelId === b.model.modelId) return 0;
  return a.model.modelId < b.model.modelId ? -1 : 1;
}

/* -------------------------------------------------------------------------- */
/*  Live voice (calls)                                                         */
/* -------------------------------------------------------------------------- */

export interface LiveVoiceLine {
  readonly model: Model;
  /** The voice id: sent to Kaana, never shown or returned. */
  readonly voiceId: string;
  /** What one minute of the call costs, for the credit meter. Never an order. */
  readonly usdPerMinute: number | null;
}

function holdsLiveCalls(model: Model): boolean {
  const realtime = model.capabilities.realtime;
  if (realtime === undefined) return false;
  const formats = realtime.audioFormats;
  return (
    realtime.sessionKinds.includes('live') &&
    realtime.transports.includes('websocket') &&
    (formats?.input === undefined || formats.input.includes('pcm16_24khz')) &&
    (formats?.output === undefined || formats.output.includes('pcm16_24khz'))
  );
}

/**
 * The lines a call tries, in order (ADR 0041 §1, Kaana ADR 0012 §4): Kaana's
 * default `live` line first — the active line whose
 * `capabilities.realtime.defaultKinds` names `live` — then every other active
 * `live` line in the catalogue's own order, which the call reaches only on the
 * model's own refusal. Each with the catalogue voice of the person's gender; a
 * line without one is skipped. Nothing is ranked by price and no model is
 * named here: which provider speaks is the catalogue's decision.
 */
export function liveVoiceLines(
  models: readonly Model[],
  wanted: { readonly voice: ProductVoice },
): LiveVoiceLine[] {
  const lines: Array<LiveVoiceLine & { readonly isDefault: boolean }> = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active' || !holdsLiveCalls(model)) continue;
    const voice = model.audio?.voices.find((entry) => entry.gender === wanted.voice);
    if (!voice) continue;
    lines.push({
      model,
      voiceId: voice.id,
      usdPerMinute: usdPerMinute(model),
      isDefault: model.capabilities.realtime?.defaultKinds?.includes('live') === true,
    });
  }
  return [
    ...lines.filter((line) => line.isDefault),
    ...lines.filter((line) => !line.isDefault),
  ].map(({ isDefault: _isDefault, ...line }) => line);
}

/* -------------------------------------------------------------------------- */
/*  Transcription (dictation)                                                  */
/* -------------------------------------------------------------------------- */

export interface TranscriptionCandidate {
  readonly model: Model;
  readonly usdPerMinute: number | null;
}

/**
 * Every model that can transcribe this clip (ADR 0017 §7): active, it executes
 * `audio_transcriptions` and takes the clip's media type. Cheapest minute
 * first.
 */
export function rankTranscriptionCandidates(
  models: readonly Model[],
  wanted: { readonly mediaType: AudioInputMediaType },
): TranscriptionCandidate[] {
  const candidates: TranscriptionCandidate[] = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active') continue;
    if (!model.capabilities.apiFormats?.includes('audio_transcriptions')) continue;
    if (!model.audio?.audioFormats.input.includes(wanted.mediaType)) continue;
    candidates.push({ model, usdPerMinute: usdPerMinute(model) });
  }
  return candidates.sort(byPriceThenId);
}

/* -------------------------------------------------------------------------- */
/*  Streaming transcription (dictation sessions)                               */
/* -------------------------------------------------------------------------- */

/**
 * Every model that can hold a streaming dictation (ADR 0024): active, a
 * `transcription` session over `websocket` that takes 24 kHz PCM16. Cheapest
 * minute first. No model is excluded for its language: Kaana gives every model
 * the language, or none for it to detect (Kaana ADR 0003).
 */
export function rankTranscriptionSessionCandidates(
  models: readonly Model[],
): TranscriptionCandidate[] {
  const candidates: TranscriptionCandidate[] = [];
  for (const model of models) {
    if (model.deprecation.status !== 'active') continue;
    const realtime = model.capabilities.realtime;
    if (
      realtime === undefined ||
      !realtime.sessionKinds.includes('transcription') ||
      !realtime.transports.includes('websocket')
    )
      continue;
    const formats = realtime.audioFormats?.input ?? [];
    if (formats.length > 0 && !formats.includes('pcm16_24khz')) continue;
    candidates.push({ model, usdPerMinute: usdPerMinute(model) });
  }
  return candidates.sort(byPriceThenId);
}
