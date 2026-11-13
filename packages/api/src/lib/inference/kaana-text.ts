/**
 * One-shot text generation directly through Kaana, for product code.
 *
 * Most of Alia needs only a string back from a prompt. This helper sends that
 * request through the published Kaana SDK, using workload identity from Oxy.
 * Prompt and output travel only between Gemies and Kaana.
 *
 * An empty generated answer is represented as `null`; configuration and
 * transport failures throw. Hosted callers never select a second provider path.
 *
 * ## What it does not do
 *
 * Tools, streaming, images and audio. The chat adapter carries the larger
 * surface; this helper stays intentionally narrow for one-shot derivations.
 */

import type { ResponseFormat } from '@kaana.ai/contracts';

import { UTILITY_POWER_LEVEL, utilityOutputTokens } from '../chat-core.js';
import { getHostedKaanaClient, disposeHostedKaanaClient } from '../kaana/transport.js';
import type { AliaInferenceSurface } from './product-seam.js';
import { fitControlledInput } from './request-budget.js';

/**
 * How long a call may take when the caller does not say.
 *
 * Also the value both clocks were hardcoded to before either was settable, so
 * a caller that passes nothing gets exactly what it got before.
 */
const DEFAULT_BUDGET_MS = 30_000;

export interface KaanaTextRequest {
  /**
   * The `publisher/model` to run. Absent runs the utility model — the cheapest
   * catalogue model fit for background work (`lib/models/selection.ts`).
   */
  readonly model?: string;
  /** The whole instruction. One user turn, because there is no conversation here. */
  readonly prompt: string;
  /** Which product surface is asking, for cost attribution on the receipt. */
  readonly surface: AliaInferenceSurface;
  /**
   * The answer's size. A call without `model` runs the utility level, whose
   * model may reason, so its reasoning allowance is added on top
   * (`utilityOutputTokens`, `chat-core.ts`).
   */
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** The Oxy account this is for, or `null` for a call no user is waiting on. */
  readonly oxyUserId?: string | null;
  /**
   * Ask for JSON back rather than prose, where the caller needs a shape.
   *
   * A caller that parses the answer has to send this: without it the model was
   * never asked for the thing being parsed, and the parse is a hope.
   */
  readonly responseFormat?: ResponseFormat;
  /**
   * How long the whole call may take, in milliseconds.
   *
   * The SDK request is aborted at this deadline. Oxy and Kaana may enforce
   * tighter upstream limits independently.
   */
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
}

class KaanaClientUnavailableError extends Error {
  readonly code = 'KAANA_CLIENT_UNAVAILABLE' as const;

  constructor() {
    super('Kaana is required for hosted text generation but no client is configured');
    this.name = 'KaanaClientUnavailableError';
  }
}

/**
 * The generated text, or `null` when Kaana returned no text.
 *
 * `derived` visibility and `drop` on disconnect: every caller today is a
 * background derivation — a suggestion, a title, a summary — that nobody is
 * watching a spinner for. A user-facing turn wants different answers to both
 * questions and should build its own context rather than inherit these.
 */
export async function generateTextViaKaana(request: KaanaTextRequest): Promise<string | null> {
  const budgetMs = request.budgetMs ?? DEFAULT_BUDGET_MS;
  // One user message has nothing to shrink: an input over Oxy's byte budget is
  // refused here, typed, rather than at the edge (`request-budget.ts`).
  const { messages } = fitControlledInput(
    {
      messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
      tools: [],
      ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    },
    { surface: request.surface },
  );
  const client = getHostedKaanaClient(request.oxyUserId);
  if (client === null) throw new KaanaClientUnavailableError();
  const completion = await client.responses
    .create(
      {
        // A named model when the caller has one; otherwise the utility power level,
        // which Kaana resolves to an admitted model (`chat-core.ts`).
        model: request.model ?? UTILITY_POWER_LEVEL,
        input: messages,
        maxOutputTokens:
          request.model === undefined
            ? utilityOutputTokens(request.maxOutputTokens)
            : request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        tools: [],
        ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
        labels: { 'alia.surface': request.surface, 'alia.visibility': 'derived' },
      },
      {
        signal: request.signal ?? AbortSignal.timeout(budgetMs),
        ...(request.oxyUserId === undefined || request.oxyUserId === null
          ? {}
          : { onBehalfOfUserId: request.oxyUserId }),
      },
    )
    .finally(() => disposeHostedKaanaClient(client));
  const text = completion.output
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text' || part.type === 'refusal')
    .map((part) => part.text)
    .join('')
    .trim();
  return text === '' ? null : text;
}
