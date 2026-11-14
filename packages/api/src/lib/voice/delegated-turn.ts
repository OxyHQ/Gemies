/**
 * One spoken turn, answered by the chat route (ADR 0041 §2).
 *
 * Every `delegation.requested` of a call is a turn of its conversation through
 * `POST /alia/chat`, the same handler a typed turn and a Telegram person turn
 * reach (`routes/chat.ts`, `lib/gemie-telegram-bot.ts`): the same
 * authentication of the person's own session and the app assertion that
 * names the surface, the same gemie, `ToolPipeline`, memory, skills, model
 * selection through Kaana, credits, rate limit and storage. The request is the
 * one the SDK sends for a typed turn (`use-conversation-stream.ts`): the stored
 * history with its ids plus the person's words, `assistantMessageId`, a
 * `turnId` for Stop, and `responseMode: 'voice'` so `prompts/voice.md` shapes
 * the answer for speech. The chat route stores the person's words and the
 * answer, as it stores a typed turn's: there is no second writer.
 *
 * It is asked over this process's own loopback port, so a voice turn is
 * served by the very code a typed one is, middleware included, with no
 * internal entry that could drift from it.
 */

import { randomUUID } from 'node:crypto';
import { OXY_APP_ASSERTION_HEADER } from '@oxy.so/contracts';
import { API_PORT } from '../api-port.js';
import type { HistoryMessage } from './persona.js';

/** What the device and the voice learn of a running turn. */
export type DelegatedTurnEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool.started'; readonly callId: string; readonly name: string }
  | {
      readonly type: 'tool.finished';
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
    };

/** The person's credentials for a turn: their session, and the app it is in. */
export interface TurnCredentials {
  readonly accessToken: string;
  /** The `X-Oxy-App-Assertion` of the call's app (ADR 0021), or `null`. */
  readonly appAssertion: string | null;
}

export interface DelegatedTurnRequest extends TurnCredentials {
  readonly conversationId: string;
  /** The gemie the call named; absent is Alia, as in a typed turn. */
  readonly agentId?: string;
  /** The stored conversation, oldest first, then the person's words. */
  readonly messages: readonly HistoryMessage[];
  readonly assistantMessageId: string;
  /** The turn's control id, which {@link VoiceTurnRunner.cancel} stops. */
  readonly turnId: string;
  readonly signal: AbortSignal;
}

/** A turn that ended without an answer: the chat route's typed failure, never a filler. */
export class DelegatedTurnFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`The chat turn failed: ${code}`);
    this.name = 'DelegatedTurnFailure';
  }
}

/** How a call runs and stops its turns; tests replace it. */
export interface VoiceTurnRunner {
  /**
   * The turn's events while it runs. Ends when the answer is complete and
   * stored; throws {@link DelegatedTurnFailure} when the turn failed, and an
   * abort error when `signal` aborted it.
   */
  run(request: DelegatedTurnRequest): AsyncIterable<DelegatedTurnEvent>;
  /** Stop a running turn the way the app's Stop does (`POST /v1/chat/turns/:id/cancel`). */
  cancel(
    turn: TurnCredentials & { readonly turnId: string; readonly conversationId: string },
  ): Promise<void>;
}

export function newTurnId(): string {
  return randomUUID();
}

const USER_AGENT = 'gemies-voice/1';

function headers(credentials: TurnCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    ...(credentials.appAssertion === null
      ? {}
      : { [OXY_APP_ASSERTION_HEADER]: credentials.appAssertion }),
  };
}

interface ChatFrame {
  error?: { code?: unknown };
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{ id?: unknown; function?: { name?: unknown } }>;
    };
  }>;
  tool_call_id?: unknown;
  name?: unknown;
  output?: unknown;
}

function codeOf(error: { code?: unknown } | undefined): string {
  return typeof error?.code === 'string' && error.code !== '' ? error.code : 'turn_failed';
}

/** A tool's output that reports a failure, as the stream runner judges one. */
function reportsFailure(output: unknown): boolean {
  return typeof output === 'object' && output !== null && 'error' in output;
}

/**
 * The events of one SSE frame of `/alia/chat`, or a failure. `alia.*` events
 * other than tool results, reasoning and usage are the app's and not spoken.
 */
export function eventsOfFrame(
  name: string | undefined,
  frame: ChatFrame,
): DelegatedTurnEvent[] | DelegatedTurnFailure {
  if (frame.error) return new DelegatedTurnFailure(codeOf(frame.error), 200);
  if (name === 'alia.tool_result') {
    if (typeof frame.tool_call_id !== 'string' || typeof frame.name !== 'string') return [];
    return [
      {
        type: 'tool.finished',
        callId: frame.tool_call_id,
        name: frame.name,
        ok: !reportsFailure(frame.output),
      },
    ];
  }
  if (name !== undefined) return [];
  const events: DelegatedTurnEvent[] = [];
  const delta = frame.choices?.[0]?.delta;
  for (const call of delta?.tool_calls ?? []) {
    if (typeof call.id === 'string' && typeof call.function?.name === 'string')
      events.push({ type: 'tool.started', callId: call.id, name: call.function.name });
  }
  if (typeof delta?.content === 'string' && delta.content !== '')
    events.push({ type: 'text', text: delta.content });
  return events;
}

/**
 * Read an SSE body frame by frame: the frame's event name and its JSON. Returns
 * whether the stream reached `[DONE]`; one that stopped before it was cut.
 */
async function* readFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ name: string | undefined; frame: ChatFrame }, boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (line === '') {
          name = undefined;
          continue;
        }
        if (line.startsWith('event:')) {
          name = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return true;
        let frame: ChatFrame;
        try {
          frame = JSON.parse(data) as ChatFrame;
        } catch {
          continue;
        }
        yield { name, frame };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The chat route over this process's own loopback port: what a call's turns run through.
 *
 * `identity: 'session'` (every call): each request carries the person's own
 * session and the app assertion the socket verified, and a `turnId` the app's
 * Stop names, so a superseded turn is stopped by the route itself.
 * `identity: 'transport'`: `fetch` already presents who the turn is for — the
 * production voice canary's Oxy workload acting through the QA account's task,
 * as the chat canary enters — and a channel identity has no turn control, so
 * no `turnId` is sent and a superseded turn is only no longer read.
 */
export function chatRouteTurnRunner(
  options: {
    readonly baseURL?: string;
    readonly fetch?: typeof fetch;
    readonly identity?: 'session' | 'transport';
  } = {},
): VoiceTurnRunner {
  const baseURL = options.baseURL ?? `http://127.0.0.1:${API_PORT}`;
  const fetchImpl = options.fetch ?? fetch;
  const asPerson = (options.identity ?? 'session') === 'session';
  const credentialHeaders = (credentials: TurnCredentials) =>
    asPerson
      ? headers(credentials)
      : { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  return {
    async *run(request) {
      const response = await fetchImpl(`${baseURL}/alia/chat`, {
        method: 'POST',
        headers: { ...credentialHeaders(request), Accept: 'text/event-stream' },
        body: JSON.stringify({
          ...(asPerson ? { turnId: request.turnId } : {}),
          messages: request.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            ...(message.toolInvocations ? { toolInvocations: message.toolInvocations } : {}),
          })),
          assistantMessageId: request.assistantMessageId,
          conversationId: request.conversationId,
          ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
          stream: true,
          responseMode: 'voice',
        }),
        signal: request.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: unknown } | string;
        } | null;
        const error = typeof body?.error === 'object' ? body.error : undefined;
        throw new DelegatedTurnFailure(codeOf(error), response.status);
      }
      const frames = readFrames(response.body);
      try {
        for (;;) {
          const next = await frames.next();
          if (next.done) {
            request.signal.throwIfAborted();
            if (!next.value) throw new DelegatedTurnFailure('stream_cut', response.status);
            return;
          }
          const events = eventsOfFrame(next.value.name, next.value.frame);
          if (events instanceof DelegatedTurnFailure) throw events;
          yield* events;
        }
      } finally {
        await frames.return(false);
      }
    },
    async cancel(turn) {
      if (!asPerson) return;
      const response = await fetchImpl(`${baseURL}/v1/chat/turns/${turn.turnId}/cancel`, {
        method: 'POST',
        headers: headers(turn),
        body: JSON.stringify({ conversationId: turn.conversationId }),
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
    },
  };
}
