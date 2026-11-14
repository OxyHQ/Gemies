# 41. Voice turns are delegated to the turn pipeline; the voice is a Kaana catalogue default

*Cada turno de voz lo responde el mismo pipeline que el chat escrito; qué voz suena lo decide el catálogo de Kaana.*

**Status:** Accepted by the owner on 2026-11-14, with the answers recorded in Kaana ADR 0012 §9 (one
OpenAI project, verbatim spans, `marin`/`cedar`, Grok kept as the fallback). Being built as phase G1.
Production voice stays on the ADR 0017 path until G1 ships and its canary passes.

**Date:** 2026-11-14

**Amends:** [ADR 0017](./0017-voice-is-a-realtime-session-through-kaana.md) §2 (how the model is chosen) and
§3 (what a call speaks with). Dictation (§7) and [ADR 0024](./0024-streaming-dictation-is-a-transcription-session.md)
are unchanged.

**Depends on:** Kaana ADR 0012, "Live voice sessions with delegation" (OxyHQ/Kaana, `docs/adr/0012-live-voice-sessions-with-delegation.md`).

## Context

The owner, 2026-11-14: voice mode moves from xAI Grok Voice to OpenAI GPT-Live. Switching later to Grok,
ElevenLabs or another provider must be a catalogue or routing change, not a rewrite. Every spoken turn
must run with the same gemie, tools, memory and model as a typed turn.

Today a call is a second brain. `lib/voice/turn.ts` builds the voice model's instructions, and
`lib/voice/tool-bridge.ts` hands it a translated copy of the gemie's tools, which the realtime model calls
itself. `lib/models/voice-models.ts` picks that model: the cheapest catalogue line that holds a
`conversation` with tools and has a voice of the person's gender. That is `x-ai/grok-voice-3.0`, the only
one production serves. The voice and the reasoning are chosen together, and a voice-only tool list has to
be kept in step with text.

## Decision

1. **A call opens a Kaana `live` session on the catalogue's default line.** Gemies reads `GET /v1/models`
   and takes the active line whose `capabilities.realtime.defaultKinds` names `live` (Kaana ADR 0012 §4),
   then the other `live` lines as fallbacks, tried only on the model's own refusal, as today. Gemies names
   no model and ranks none by price. The voice is the catalogue voice of the person's gender
   (`male` | `female`) on that line (`cedar` and `marin` on GPT-Live). The audio format is `pcm16_24khz`
   both ways, as the SDK's audio engine already plays.
2. **Every `delegation.requested` is one turn of the conversation, through the chat route.** The person's
   words (`text`) are appended to the conversation as their message. The gemie answers through the same
   path a typed turn takes, the one a Telegram person turn already takes (`POST /alia/chat`, see
   `lib/gemie-telegram-bot.ts`), with `responseMode: 'voice'` so `prompts/voice.md` shapes the answer for
   speech. Same gemie, same `ToolPipeline`, same memory, same skills, same model selection through Kaana,
   same credits. The answer streams back as `delegation.reply` chunks, one per sentence, the last one with
   `final: true`, and is stored as the gemie's message. Each chunk marks its numbers, addresses, names and
   codes as `verbatim` spans, which the voice says exactly (Kaana ADR 0012 §9.2).
3. **The voice holds only a persona.** The `live` open carries the gemie's name, its voice style and the
   person's language, plus the recent conversation as `history`. No tools and no backend instructions go
   to the voice.
4. **A superseded turn is aborted.** `delegation.superseded` or `delegation.cancel` aborts that turn's
   `AbortSignal`. A tool that has already run is reported by the next turn, never retried.
5. **Billing.** The voice minute is the line's `pricePerMinute`, metered by `VoiceCreditMeter` as today.
   Each delegated turn is a typed turn and is charged as one. The call's duration ceiling stays Oxy's
   (`realtimeDurationCeiling`).
6. **Deleted when G1 ships, in the same change:** `lib/voice/tool-bridge.ts`, the instruction and tool
   building of `lib/voice/turn.ts`, the tool-call handling in `lib/voice/call.ts`,
   `rankRealtimeCandidates` and its candidate fallback, and their tests. `rankTranscriptionCandidates` and
   `rankTranscriptionSessionCandidates` stay: dictation is unchanged.
7. **Canary.** A production canary opens a `live` session through Kaana as a test account, streams
   recorded speech, receives audio back, and answers one delegated turn whose answer calls a tool (a
   reminder, created and then deleted). It records the call id, Kaana's `requestId` and both settlements.

## Consequences

- Voice has exactly the tools text has, including connectors and other gemies, with nothing to mirror.
- Changing the voice provider is an Oxy catalogue change. Gemies is not edited.
- A spoken answer waits for a backend turn. The voice's acknowledgement and per-sentence replies cover the
  gap.
- GPT-Live paraphrases what it is given. Verbatim spans keep figures, addresses, names and codes exact, and
  `prompts/voice.md` keeps answers short and speakable.
