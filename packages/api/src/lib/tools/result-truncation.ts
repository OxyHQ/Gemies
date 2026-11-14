/**
 * Tool Result Truncation
 * Caps tool output to a percentage of the model's context window.
 * Truncates at paragraph/newline boundaries to keep content coherent.
 * Inspired by ZeroClaw's truncate_with_ellipsis pattern.
 */

import type { ToolSet } from 'ai';
import { withoutHostImageData } from '../chat/host-image-result.js';
import { log } from '../logger.js';

const DEFAULT_MAX_CHARS = 6000; // ~1500 tokens at 4 chars/token

/**
 * Truncate a tool result string to fit within a character budget.
 * @param result - Raw tool result text
 * @param maxChars - Maximum characters allowed (default 6000)
 * @returns Truncated string with marker if truncated
 */
export function truncateToolResult(result: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  if (!result || result.length <= maxChars) return result;

  const omitted = result.length - maxChars;

  // Find last newline within the budget for a clean break
  const slice = result.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;

  log.general.info(
    { original: result.length, truncated: cutPoint, omitted },
    'Tool result truncated',
  );

  return result.slice(0, cutPoint) + `\n\n[truncated — ${omitted} chars omitted]`;
}

/**
 * Calculate max chars for tool results based on model context window.
 * Targets 30% of the context window for tool output.
 * @param contextTokens - Model's total context window in tokens
 * @returns Max characters for tool results
 */
export function getToolResultBudget(contextTokens: number): number {
  // 30% of context window, converted to chars (4 chars/token estimate)
  const budget = Math.floor(contextTokens * 0.3 * 4);
  // Clamp between 2000 and 20000 chars
  return Math.max(2000, Math.min(20000, budget));
}

/** Fields long prose usually lives in; the cheap, shape-preserving first pass. */
const CONTENT_FIELDS = new Set(['content', 'text', 'output', 'result']);
/** An array longer than this keeps its head and says how many it dropped. */
const MAX_ARRAY_ITEMS = 50;
/** The fewest items a list keeps while it is cut to fit: a result is never emptied of them. */
const MIN_ARRAY_ITEMS = 3;

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A value that says nothing: absent, an empty string, an empty list or an empty object. */
function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0)
  );
}

/**
 * A result without the fields that say nothing, at every depth: `null`, `''`, `[]` and `{}`
 * values, and an `_id` that repeats the record's own `id` (a store's key echoed beside it). A
 * list of twenty emails from Inbox is mostly that (`cc: []`, `inReplyTo: null`, `labels: []`, …):
 * dropped, it costs half as much and loses nothing a reader or a model could use. A top-level
 * `card` is a UI payload rendered as-is and is never touched.
 */
export function compactToolResult(value: unknown): unknown {
  const compact = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(compact);
    if (!isPlainObject(entry)) return entry;
    const kept: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(entry)) {
      if (key === '_id' && entry.id !== undefined && field === entry.id) continue;
      const compacted = compact(field);
      if (!isEmptyValue(compacted)) kept[key] = compacted;
    }
    return kept;
  };
  if (!isPlainObject(value)) return compact(value);
  const { card, ...rest } = value;
  const compacted = compact(rest) as Record<string, unknown>;
  return card === undefined ? compacted : { ...compacted, card };
}

/** Every string leaf at most `leafChars`, every array at most `maxItems`. */
function boundLeaves(value: unknown, leafChars: number, maxItems = MAX_ARRAY_ITEMS): unknown {
  if (typeof value === 'string') return truncateToolResult(value, leafChars);
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxItems).map((item) => boundLeaves(item, leafChars, maxItems));
    if (value.length > maxItems)
      kept.push(`[truncated — ${value.length - maxItems} more items omitted]`);
    return kept;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, boundLeaves(entry, leafChars, maxItems)]),
    );
  }
  return value;
}

/**
 * Bound what a tool hands the model to `maxChars` of JSON, whatever its shape, and keep it JSON a
 * model can read.
 *
 * This used to rewrite only TOP-LEVEL string fields named content/text/output/
 * result and pass everything else through, so an app result shaped
 * `{ data: { body } }` or a list of emails reached the model whole: four
 * `readEmail` calls in one turn overran the inference edge's input ceiling and
 * the turn failed (`context_length_exceeded`, production 2026-10-08/10).
 *
 * Then a list too long for the budget became ONE string, `{ truncated, preview }`, the first
 * `maxChars` of its JSON escaped inside another: twenty unread emails were mostly ids and empty
 * fields, and a follow-up run read only the head of that string, saw no email it could summarise,
 * and listed them again until its token budget was spent (production 2026-11-14). Now the result
 * is compacted first ({@link compactToolResult}); what still does not fit has its string leaves
 * shortened, then its lists cut to their head, with a marker saying how many items were left out.
 * The preview remains only for a result with nothing left to cut.
 *
 * A top-level `card` is a UI payload stored and rendered as-is, so it is never touched and never
 * counted.
 */
function boundObject(obj: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const { card, ...rest } = obj;
  const withCard = (body: Record<string, unknown>) =>
    card === undefined ? body : { ...body, card };

  // First the shape-preserving passes: nothing that says nothing, and top-level prose bounded.
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(compactToolResult(rest) as Record<string, unknown>)) {
    trimmed[key] =
      typeof value === 'string' && CONTENT_FIELDS.has(key)
        ? truncateToolResult(value, maxChars)
        : value;
  }
  if (serializedLength(trimmed) <= maxChars + 64) return withCard(trimmed);

  const leafChars = Math.min(maxChars, Math.max(200, Math.floor(maxChars / 8)));
  for (let items = MAX_ARRAY_ITEMS; ; items = Math.floor(items / 2)) {
    const shortened = boundLeaves(trimmed, leafChars, items) as Record<string, unknown>;
    if (serializedLength(shortened) <= maxChars) return withCard(shortened);
    if (items <= MIN_ARRAY_ITEMS) break;
  }

  log.general.info(
    { original: serializedLength(rest), maxChars },
    'Tool result reduced to a preview',
  );
  return withCard({
    truncated: true,
    preview: truncateToolResult(
      JSON.stringify(boundLeaves(trimmed, leafChars, MIN_ARRAY_ITEMS)),
      maxChars,
    ),
  });
}

/**
 * A tool result bounded to `maxChars` of JSON, whatever it is: the one bound for the model
 * ({@link wrapToolsWithTruncation}) and for what an autonomous run keeps of an observation.
 */
export function boundToolResult(result: unknown, maxChars: number = DEFAULT_MAX_CHARS): unknown {
  if (typeof result === 'string') return truncateToolResult(result, maxChars);
  if (Array.isArray(result)) {
    const bounded = boundObject({ items: result }, maxChars);
    return 'items' in bounded ? bounded.items : bounded;
  }
  if (isPlainObject(result)) return boundObject(result, maxChars);
  return result;
}

/**
 * A stored or streamed tool result as a client receives it: the live `alia.tool_result` frame and
 * every conversation read (`lib/chat/client-message.ts`) carry exactly this. An image's bytes are
 * left out (`host-image-result.ts`) and so is every field that says nothing
 * ({@link compactToolResult}); what the thread draws from a result (a card, its sources, a host
 * app's own drawing of its tool) is kept.
 */
export function clientToolResult(result: unknown): unknown {
  return compactToolResult(withoutHostImageData(result));
}

/**
 * Wrap all tools in a ToolSet with automatic result truncation.
 * Intercepts each tool's execute function to truncate string-heavy results.
 */
export function wrapToolsWithTruncation(
  tools: ToolSet,
  maxChars: number = DEFAULT_MAX_CHARS,
): ToolSet {
  const wrapped: ToolSet = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }

    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (...args: any[]) =>
        boundToolResult(
          await (originalExecute as (...args: unknown[]) => unknown)(...args),
          maxChars,
        ),
    };
  }

  return wrapped;
}
