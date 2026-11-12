/**
 * The SHAPE of a stream chunk this client could not read — never its content.
 *
 * A consumer logs this verbatim. The assistant's text, the person's prompt and
 * any upstream message are deliberately absent: what a reader needs in order to
 * fix a protocol mismatch is which keys arrived, not what they said.
 */
export interface GemieChunkShape {
  /** The chunk's top-level keys, capped, when it parsed as a JSON object. */
  readonly keys?: readonly string[];
  /** `choices.length`, or the `typeof` when `choices` was not an array. */
  readonly choices?: number | string;
  /** `error.code` / `error.type` when the chunk carried an error object. */
  readonly errorCode?: string;
  /** The SSE `event:` name the frame carried, when it had one. */
  readonly event?: string;
  /** `typeof` the parsed value, when it was not a JSON object. */
  readonly valueType?: string;
}

/**
 * Why a stream could not be read. Every one of these is a protocol mismatch
 * between this client and the server, not an answer the server gave.
 */
export type GemieStreamFailure =
  /** The response was 2xx but not `text/event-stream`. */
  | 'not_event_stream'
  /** The response was 2xx, SSE, and had no readable body. */
  | 'no_body'
  /** A `data:` payload was not JSON. */
  | 'malformed_json'
  /** A chunk parsed, but is neither an OpenAI chunk nor an error payload. */
  | 'unexpected_chunk'
  /** A choice arrived without a `delta` object. */
  | 'choice_without_delta'
  /** `delta.content` was present and not a string. */
  | 'content_not_string'
  /** Tool fragments have invalid indices or field types. */
  | 'invalid_tool_calls'
  /** The body ended before `data: [DONE]`. */
  | 'truncated'
  /** The stream exceeded this client's byte or frame limits. */
  | 'oversized';

/**
 * The stream itself could not be read.
 *
 * Distinct from {@link GemieRequestError}, which means the server answered and
 * said no. This one means the bytes did not match the protocol, and it always
 * carries the shape that broke it so the mismatch is nameable from a log line.
 */
export class GemieStreamError extends Error {
  readonly failure: GemieStreamFailure;
  readonly shape: GemieChunkShape;

  constructor(failure: GemieStreamFailure, shape: GemieChunkShape = {}) {
    super(`Alia stream could not be read: ${failure}`);
    this.name = 'GemieStreamError';
    this.failure = failure;
    this.shape = shape;
  }
}

/**
 * Alia answered with a non-2xx status.
 *
 * `code` is the machine-readable code from the body when the body was small
 * JSON that carried one — `code` or `error.code`. The body's prose is NOT
 * retained: an upstream message is not a consumer's to show, and a client that
 * keeps it invites a product surface to print it.
 */
export class GemieRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  /**
   * Whether sending the same turn again can help, when Alia said. A turn that
   * failed before any output is a 503 with `retryable: true`; a refusal of the
   * request itself is not.
   */
  readonly retryable: boolean | null;
  /** Seconds to wait before retrying, when Alia said. */
  readonly retryAfter: number | null;
  /** Alia's run id for a failed turn, for support. */
  readonly reference: string | null;

  constructor(status: number, code: string | null = null, failure: GemieFailureDetail = {}) {
    super(`Alia responded ${status}`);
    this.name = 'GemieRequestError';
    this.status = status;
    this.code = code;
    this.retryable = failure.retryable ?? null;
    this.retryAfter = failure.retryAfter ?? null;
    this.reference = failure.reference ?? null;
  }
}

/** The non-prose fields of Alia's error envelope beyond its code. */
export interface GemieFailureDetail {
  readonly retryable?: boolean;
  readonly retryAfter?: number;
  readonly reference?: string;
}

/** Read {@link GemieFailureDetail} off an error object, dropping mistyped fields. */
export function failureDetailOf(error: Record<string, unknown>): GemieFailureDetail {
  return {
    ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    ...(typeof error.retryAfter === 'number' &&
    Number.isFinite(error.retryAfter) &&
    error.retryAfter >= 0
      ? { retryAfter: error.retryAfter }
      : {}),
    ...(typeof error.reference === 'string' &&
    error.reference !== '' &&
    error.reference.length <= 128
      ? { reference: error.reference }
      : {}),
  };
}

/** The caller's `AbortSignal` fired. `name` is `AbortError`, as fetch's is. */
export class GemieAbortError extends Error {
  constructor(message = 'The Alia stream was aborted.') {
    super(message);
    this.name = 'AbortError';
  }
}

const MAX_SHAPE_KEYS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Describe a parsed chunk without repeating anything it said. */
export function describeChunk(value: unknown, event?: string): GemieChunkShape {
  const named = event === undefined || event === '' ? {} : { event };
  if (!isRecord(value)) return { ...named, valueType: value === null ? 'null' : typeof value };

  const error = isRecord(value.error) ? value.error : undefined;
  const errorCode =
    error === undefined
      ? undefined
      : typeof error.code === 'string'
        ? error.code
        : typeof error.type === 'string'
          ? error.type
          : undefined;

  return {
    ...named,
    keys: Object.keys(value).slice(0, MAX_SHAPE_KEYS),
    choices: Array.isArray(value.choices) ? value.choices.length : typeof value.choices,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export { isRecord };
