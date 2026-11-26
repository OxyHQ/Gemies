/**
 * A coding CLI asking its own user for permission, in the conversation (Gemies ADR 0043 §5).
 *
 * During a turn with an external agent (Claude Code on the person's computer), the CLI may stop and
 * ask whether it can run something there. The turn waits; the stream carries two named events:
 *
 *   `alia.cli_permission_request`   the CLI asks: which tool, on what.
 *   `alia.cli_permission_resolved`  the answer was given, or the time ran out.
 *
 * This is the third-party CLI's prompt to the person who runs it, on their own machine. It is not
 * an Oxy grant: nothing here reaches Oxy, and the SDK does not know the endpoint that carries the
 * answer — the host does (`GemieRuntimeHost.onApprovalDecision`).
 */

export type ApprovalDecision = 'allow' | 'deny';
export type ApprovalOutcome = ApprovalDecision | 'expired';

export interface ApprovalRequest {
  readonly requestId: string;
  readonly agentId: string;
  /** The CLI's tool: `Bash`, `Edit`, … */
  readonly tool: string;
  /** What it would act on (a command, a path), as the daemon reported it. */
  readonly summary?: string;
  /** ISO time after which the CLI is told no. */
  readonly expiresAt: string;
}

/** A request and where it stands: waiting for the person, or how it ended. */
export interface ApprovalEntry extends ApprovalRequest {
  readonly outcome: 'pending' | ApprovalOutcome;
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;

/** The request in an `alia.cli_permission_request` frame, or `null` when the frame is not one. */
export function parseApprovalRequest(data: unknown): ApprovalRequest | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const requestId = text(d.requestId, 100);
  const agentId = text(d.agentId, 100);
  const tool = text(d.tool, 80);
  const expiresAt = text(d.expiresAt, 40);
  if (!requestId || !agentId || !tool || !expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    return null;
  }
  const summary = text(d.summary, 200);
  return { requestId, agentId, tool, ...(summary ? { summary } : {}), expiresAt };
}

/** The answer in an `alia.cli_permission_resolved` frame, or `null` when the frame is not one. */
export function parseApprovalResolved(
  data: unknown,
): { requestId: string; outcome: ApprovalOutcome } | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const requestId = text(d.requestId, 100);
  if (!requestId) return null;
  const decision = d.decision;
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'expired') return null;
  return { requestId, outcome: decision };
}

/** A request arrived: waiting, once. A repeat of one already here changes nothing. */
export function withApprovalRequest(
  list: readonly ApprovalEntry[],
  request: ApprovalRequest,
): ApprovalEntry[] {
  if (list.some((entry) => entry.requestId === request.requestId)) return [...list];
  return [...list, { ...request, outcome: 'pending' }];
}

/** A request was answered. The first answer stands; an unknown request is ignored. */
export function withApprovalOutcome(
  list: readonly ApprovalEntry[],
  requestId: string,
  outcome: ApprovalOutcome,
): ApprovalEntry[] {
  return list.map((entry) =>
    entry.requestId === requestId && entry.outcome === 'pending' ? { ...entry, outcome } : entry,
  );
}

/**
 * What a host's `onApprovalDecision` rejects with when the question is no longer open (answered
 * elsewhere, or its time ran out): the card then reads "Timed out" instead of offering a retry.
 */
export class ApprovalExpiredError extends Error {
  constructor() {
    super('The approval request is no longer open');
    this.name = 'ApprovalExpiredError';
  }
}

/** What a new turn keeps of the last one's approvals: the ones still waiting. */
export function stillPending(list: readonly ApprovalEntry[]): ApprovalEntry[] {
  return list.filter((entry) => entry.outcome === 'pending');
}
