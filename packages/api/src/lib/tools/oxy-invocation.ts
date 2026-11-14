/**
 * Calling an Oxy app capability: the execution authorization, the short-lived
 * ticket, the HTTP or internal-MCP invocation and its idempotency key. Takes a
 * bound tool (`oxy-catalog-defs.ts`) and a context (`oxy-call-context.ts`);
 * never decides which tools exist. Gemies acts for the person on what Oxy's
 * first-party registry declares for it (Oxy ADR 0066): no session, task or
 * approval to hold or retire.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  firstPartyExecutionAuthorizationInputSchema,
  type CapabilityCatalogBinding,
  type AppCapabilityCatalog,
  type CatalogTool,
} from '@oxy.so/contracts';
import { createInternalCatalogMcpClient, InternalMcpRefusedError } from '@oxy.so/mcp';
import { z } from 'zod';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { agency, type BoundTool } from './oxy-catalog-defs.js';
import {
  OxyAuthorityUnavailableError,
  OxyOutcomeUnknownError,
  oxyRunScopeKey,
  type OxyToolExecutionContext,
} from './oxy-call-context.js';

const TOOL_TIMEOUT_MS = 15_000;

const ticketResponseSchema = z.object({
  decision: z.object({ allowed: z.boolean(), reason: z.string() }).loose(),
  ticket: z.string().min(1).optional(),
});

function resolveInvocation(
  catalog: AppCapabilityCatalog,
  definition: CatalogTool,
  args: Record<string, unknown>,
): {
  url: URL;
  body: Record<string, unknown> | undefined;
} {
  const remaining = { ...args };
  const path = definition.invocation.path.replace(/\{(\w+)\}/g, (_match, parameter: string) => {
    const value = Object.hasOwn(remaining, parameter) ? remaining[parameter] : undefined;
    delete remaining[parameter];
    if (value === undefined || value === null)
      throw new Error(`Missing required path parameter: ${parameter}`);
    return encodeURIComponent(String(value));
  });
  const baseUrl = new URL(catalog.internalBaseUrl);
  const url = new URL(path, `${catalog.internalBaseUrl}/`);
  if (url.origin !== baseUrl.origin) {
    throw new Error(`Catalog invocation for ${definition.name} escapes its registered app origin`);
  }
  if (definition.invocation.method === 'GET') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return { url, body: undefined };
  }
  return { url, body: remaining };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

/**
 * One key per tool CALL, not per argument set.
 *
 * The model no longer invents an `idempotencyKey` argument (Inbox catalog 2.0.0
 * takes it only from this header), so hashing the arguments would give two
 * deliberate identical calls in one run — star a message, unstar it, star it
 * again — the same key, and Oxy would refuse the repeat as a duplicate. The
 * SDK's `toolCallId` names exactly one call and survives a retry of that call,
 * which is the duplicate this key exists to stop. Without one (a direct
 * caller), the arguments are the best available identity.
 */
export function idempotencyKey(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string | undefined,
): string {
  return createHash('sha256')
    .update(JSON.stringify(sortJson([runId, toolName, toolCallId ?? args])))
    .digest('hex');
}

/**
 * A two-minute authorization for one call, on Gemies' declared authority. The
 * person is the context's requester; the resource names the account acted on
 * (theirs, or a bot account they operate for `self_*`). A structured run's call
 * carries its step and the tool's declared limits from the run scope.
 */
async function createDirectExecutionAuthorization(
  context: OxyToolExecutionContext,
  binding: BoundTool,
  runId: string,
): Promise<string> {
  const tool = binding.compiled.definition.name;
  const scoped = context.runScope?.[oxyRunScopeKey(binding.resource, tool)];
  if (context.runScope !== undefined && context.runIsOpen && !(await context.runIsOpen()))
    throw new OxyAuthorityUnavailableError('The task was stopped; nothing was done');
  const terms = firstPartyExecutionAuthorizationInputSchema.parse({
    authority: 'first_party' as const,
    kind: 'direct_request' as const,
    actor: context.actor,
    resource: binding.resource,
    tool,
    expectedCatalog: binding.compiled.catalogBinding,
    runId,
    ...(scoped?.stepId ? { stepId: scoped.stepId } : {}),
    limits: (scoped?.limits ?? []).map((limit) => ({ tool, key: limit.key, value: limit.value })),
    expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
  });
  return (
    await agency().createFirstPartyExecutionAuthorization(terms, {
      requesterAccountId: context.requesterAccountId,
    })
  ).id;
}

const auditedResultSchema = z
  .object({
    auditEventId: z.string().trim().min(1),
  })
  .loose();

function responseAuditEventId(response: Response, result: unknown): string | undefined {
  const header = response.headers.get('x-oxy-audit-event-id')?.trim();
  if (header) return header;
  const parsed = auditedResultSchema.safeParse(result);
  return parsed.success ? parsed.data.auditEventId : undefined;
}

async function issueTicket(
  context: OxyToolExecutionContext,
  binding: BoundTool,
  runId: string,
  expectedCatalog?: CapabilityCatalogBinding,
): Promise<string> {
  const definition = binding.compiled.definition;
  let executionAuthorizationId: string;
  if (expectedCatalog && !context.runId)
    throw new OxyAuthorityUnavailableError('Internal MCP requires a named run');
  try {
    executionAuthorizationId = await createDirectExecutionAuthorization(context, binding, runId);
  } catch (error: unknown) {
    if (expectedCatalog)
      throw new OxyAuthorityUnavailableError('Internal MCP authorization unavailable');
    throw new OxyAuthorityUnavailableError(getErrorMessage(error), { cause: error });
  }
  try {
    // The authorization bound its own run and step; the ticket request names neither.
    const request = {
      executionAuthorizationId,
      ...(expectedCatalog ? { expectedCatalog } : {}),
    };
    const parsed = ticketResponseSchema.parse(await agency().issueCapabilityTicket(request));
    if (!parsed.decision.allowed || !parsed.ticket) {
      throw new Error(`Oxy policy denied ${definition.name}: ${parsed.decision.reason}`);
    }
    return parsed.ticket;
  } catch (error: unknown) {
    if (expectedCatalog)
      throw new OxyAuthorityUnavailableError('Internal MCP ticket authority unavailable');
    throw new OxyAuthorityUnavailableError(getErrorMessage(error), { cause: error });
  }
}

interface InternalOperationOutcome {
  id: string;
  runId: string;
  tool: string;
  status: 'succeeded' | 'not_executed' | 'unknown' | 'failed';
  result?: unknown;
}

/** What the model reads when an internal-MCP call did not plainly succeed. */
function internalOutcome(outcome: InternalOperationOutcome) {
  return {
    status: outcome.status,
    ...(outcome.status === 'succeeded'
      ? { result: outcome.result }
      : { error: outcome.status === 'unknown' ? 'oxy_app_result_unknown' : 'oxy_app_unavailable' }),
    operation: { id: outcome.id, runId: outcome.runId, tool: outcome.tool },
    message:
      outcome.status === 'unknown'
        ? 'The operation outcome is unknown. Do not claim success or start the operation again.'
        : outcome.status === 'not_executed'
          ? 'The app refused the call before running it, so nothing happened. Tell the person it is unavailable right now; do not claim it ran.'
          : 'The operation was not confirmed successful.',
  };
}

async function callInternalBoundTool(
  binding: BoundTool,
  args: Record<string, unknown>,
  context: OxyToolExecutionContext,
  toolCallId: string | undefined,
  operationKey: string | undefined,
): Promise<unknown> {
  const definition = binding.compiled.definition;
  const runId = context.runId ?? '';
  const operationId =
    operationKey ??
    idempotencyKey(runId, oxyRunScopeKey(binding.resource, definition.name), args, toolCallId);
  const outcome: InternalOperationOutcome = {
    id: operationId,
    runId,
    tool: definition.name,
    status: 'not_executed',
  };
  const stepId = context.runScope?.[oxyRunScopeKey(binding.resource, definition.name)]?.stepId;
  if (stepId) await context.onStepStatus?.(stepId, 'running');
  let ticket: string;
  try {
    ticket = await issueTicket(context, binding, runId, binding.compiled.internalCatalogBinding);
  } catch (error) {
    if (stepId) await context.onStepStatus?.(stepId, 'failed');
    throw error;
  }
  outcome.status = 'unknown';
  try {
    const endpoint = new URL('/_oxy/mcp', binding.compiled.catalog.internalBaseUrl);
    const client = createInternalCatalogMcpClient({
      endpoint: endpoint.href,
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    const result = await client.callTool(ticket, definition.name, args, {
      ...(definition.idempotency === 'required' ? { idempotencyKey: operationId } : {}),
    });
    if ('isError' in result && result.isError === true) {
      outcome.status = 'failed';
    } else {
      const textResult = singleMcpTextResultSchema.safeParse(result);
      outcome.result =
        result.structuredContent ??
        (textResult.success ? parseMcpTextResult(textResult.data.content[0].text) : result);
      outcome.status = 'succeeded';
    }
  } catch (error: unknown) {
    // Refused before it ran: nothing happened. A read has no effect to be
    // unsure about. Only an effect whose transport failed after the call was
    // sent may have committed, and that alone is unknown. No fallback, remint
    // or retry of the operation is implied by this classification.
    outcome.status =
      error instanceof InternalMcpRefusedError
        ? 'not_executed'
        : definition.effect === 'read'
          ? 'failed'
          : 'unknown';
  }
  if (stepId) {
    const audit = auditedResultSchema.safeParse(outcome.result);
    await context.onStepStatus?.(
      stepId,
      outcome.status === 'succeeded' ? 'succeeded' : 'failed',
      audit.success ? audit.data.auditEventId : undefined,
    );
  }
  // Normal successful calls retain the existing domain result shape.
  return outcome.status === 'succeeded' ? outcome.result : internalOutcome(outcome);
}

/**
 * `operationKey` replaces the derived idempotency key when the CALLER owns the
 * operation's identity — a feature gate spends once per attached part, across
 * requests, so its key cannot come from this run's id.
 */
export async function callBoundTool(
  binding: BoundTool,
  args: Record<string, unknown>,
  context: OxyToolExecutionContext,
  toolCallId?: string,
  operationKey?: string,
): Promise<unknown> {
  if (binding.compiled.internalCatalogBinding) {
    return callInternalBoundTool(binding, args, context, toolCallId, operationKey);
  }
  const runId = context.runId ?? randomUUID();
  const stepId =
    context.runScope?.[oxyRunScopeKey(binding.resource, binding.compiled.definition.name)]?.stepId;
  if (stepId) await context.onStepStatus?.(stepId, 'running');
  try {
    const ticket = await issueTicket(context, binding, runId);
    const { url, body } = resolveInvocation(
      binding.compiled.catalog,
      binding.compiled.definition,
      args,
    );
    const headers: Record<string, string> = {
      authorization: `Capability ${ticket}`,
      accept: 'application/json',
    };
    if (body) headers['content-type'] = 'application/json';
    if (binding.compiled.definition.idempotency === 'required') {
      headers['idempotency-key'] =
        operationKey ?? idempotencyKey(runId, binding.compiled.definition.name, args, toolCallId);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: binding.compiled.definition.invocation.method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      // Sent, and no answer: the app may have done it.
      throw new OxyOutcomeUnknownError(
        `${binding.compiled.definition.name} sent without an answer: ${getErrorMessage(error).slice(0, 120)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const message = `Oxy app error (${response.status}): ${(await response.text()).slice(0, 240)}`;
      // 401/403 is the app refusing the ticket, not the request.
      throw response.status === 401 || response.status === 403
        ? new OxyAuthorityUnavailableError(message)
        : new Error(message);
    }
    const result = await (response.headers.get('content-type')?.includes('application/json')
      ? response.json()
      : response.text());
    if (stepId) {
      await context.onStepStatus?.(stepId, 'succeeded', responseAuditEventId(response, result));
    }
    return result;
  } catch (error: unknown) {
    if (stepId) await context.onStepStatus?.(stepId, 'failed');
    throw error;
  }
}

const singleMcpTextResultSchema = z
  .object({
    content: z.tuple([z.object({ type: z.literal('text'), text: z.string() }).loose()]),
  })
  .loose();

function parseMcpTextResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
