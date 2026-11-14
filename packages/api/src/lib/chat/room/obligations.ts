/** Explicit assignments belong to the person's immutable request, never to a peer's authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RoomDecision, RoomSelectionInput } from './decision.js';
import { textOf } from './transcript.js';

const reference = z.string().min(1).max(200);
export const ObligationSchema = z.object({
  id: reference,
  recipientId: reference,
  task: z.string().min(1).max(500),
  dependsOn: z.array(reference).max(16),
  state: z.enum(['pending', 'completed', 'waiting_person']),
  evidence: z.array(reference).max(8),
});
export const ObligationUpdatesSchema = z.array(ObligationSchema).max(16);
export interface RoomReactionContribution {
  readonly id: string;
  readonly actorId: string;
  readonly mutations: readonly { messageId: string; emoji: string; active: boolean }[];
}
export class RoomRequestSupersededError extends Error {
  constructor() {
    super('Room request superseded');
  }
}
export type RoomObligation = z.infer<typeof ObligationSchema>;
export interface RoomObligationPlan {
  readonly requestDigest: string;
  readonly triggerId: string;
  readonly rosterIds: readonly string[];
  readonly obligations: readonly RoomObligation[];
}
export type RoomSelectionResult = RoomDecision & {
  readonly obligationPlan?: RoomObligationPlan;
  readonly waitingForPerson?: true;
};
const requireFact = (ok: unknown, message: string): void => {
  if (!ok) throw new Error(`Invalid room obligations: ${message}`);
};

export const roomRequestDigest = (content: unknown) =>
  createHash('sha256').update(JSON.stringify(content)).digest('hex');

export function obligationBinding(input: RoomSelectionInput) {
  const row = input.rows.find((r) => r.id === input.triggerId);
  requireFact(row?.role === 'user', 'person request missing');
  return {
    triggerId: input.triggerId,
    requestDigest: roomRequestDigest(row!.content),
    rosterIds: input.roster.map((m) => m.info.id).sort(),
  };
}
export function assertObligationBinding(plan: RoomObligationPlan, input: RoomSelectionInput) {
  requireFact(
    JSON.stringify({
      triggerId: plan.triggerId,
      requestDigest: plan.requestDigest,
      rosterIds: [...plan.rosterIds].sort(),
    }) === JSON.stringify(obligationBinding(input)),
    'request or admitted roster changed',
  );
}

/** Validate the evidence against stored rows, never the model's claimed speaker or text. */
function hasEvidence(input: RoomSelectionInput, assignment: RoomObligation, id: string) {
  if (
    assignment.state === 'completed' &&
    input.reactionContributions?.some((r) => r.id === id && r.actorId === assignment.recipientId)
  )
    return true;
  const triggerIndex = input.rows.findIndex((r) => r.id === input.triggerId);
  const index = input.rows.findIndex((r) => r.id === id || r.clientMessageId === id);
  const row = input.rows[index];
  if (!row) return false;
  if (assignment.state === 'waiting_person') {
    // A question must come from the assigned actor. It cannot suspend another actor's task.
    return (
      index > triggerIndex &&
      row.role === 'assistant' &&
      row.agentId === assignment.recipientId &&
      textOf(row.content).trim().length > 0
    );
  }
  return (
    index > triggerIndex &&
    row.role === 'assistant' &&
    row.agentId === assignment.recipientId &&
    textOf(row.content).trim().length > 0
  );
}

/** No inference retry or substituted actor: an inconsistent plan is a typed selection failure. */
export function validateObligationSelection(
  value: unknown,
  decision: RoomDecision,
  input: RoomSelectionInput,
): RoomSelectionResult {
  const obligations = ObligationUpdatesSchema.parse(value);
  const previous = input.obligationPlan;
  if (previous) assertObligationBinding(previous, input);
  const byId = new Map(obligations.map((o) => [o.id, o]));
  requireFact(byId.size === obligations.length, 'duplicate assignment');
  const roster = new Map(input.roster.map((m) => [m.info.id, m]));
  if (previous) {
    requireFact(
      previous.obligations.length === obligations.length,
      'assignment dropped or invented',
    );
    for (const old of previous.obligations) {
      const next = byId.get(old.id);
      requireFact(
        next &&
          next.recipientId === old.recipientId &&
          next.task === old.task &&
          JSON.stringify(next.dependsOn) === JSON.stringify(old.dependsOn),
        'assignment changed',
      );
      requireFact(old.state !== 'completed' || next?.state === 'completed', 'completion reversed');
    }
  }
  for (const o of obligations) {
    requireFact(roster.has(o.recipientId), 'unknown recipient');
    requireFact(
      new Set(o.dependsOn).size === o.dependsOn.length &&
        o.dependsOn.every((id) => id !== o.id && byId.has(id)),
      'invalid dependency',
    );
    requireFact(
      o.state === 'pending'
        ? o.evidence.length === 0
        : o.evidence.length > 0 && o.evidence.every((id) => hasEvidence(input, o, id)),
      'missing recipient evidence',
    );
  }
  for (const o of obligations) {
    requireFact(
      o.state !== 'completed' || o.dependsOn.every((id) => byId.get(id)?.state === 'completed'),
      'completion before its dependencies',
    );
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    requireFact(!visiting.has(id), 'dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  const pending = obligations.filter((o) => o.state !== 'completed');
  const ready = pending.filter(
    (o) => o.state === 'pending' && o.dependsOn.every((id) => byId.get(id)!.state === 'completed'),
  );
  if (decision.action === 'clarify') {
    requireFact(
      ready.every((o) => o.recipientId === decision.agentId),
      'clarification cannot suspend another ready recipient',
    );
  }
  if (decision.action === 'idle') {
    requireFact(ready.length === 0, 'cannot complete with ready assignments');
    requireFact(
      pending.length === 0 || pending.some((o) => o.state === 'waiting_person'),
      'unfinished assignments are not completed',
    );
  }
  if (decision.action === 'speak' && decision.reason === 'directed') {
    requireFact(
      ready.some((o) => o.recipientId === decision.agentId),
      'no ready person assignment',
    );
  }
  if (decision.action === 'speak' && decision.reason === 'contribution') {
    requireFact(ready.length === 0, 'open contribution cannot replace a ready assignment');
  }
  // Explicit ordering is a readiness constraint, not permission for a new recipient or tool.
  if (decision.action === 'speak' && decision.reason !== 'handoff') {
    requireFact(
      !pending.some((o) => o.recipientId === decision.agentId) ||
        ready.some((o) => o.recipientId === decision.agentId),
      'recipient is blocked',
    );
  }
  return {
    ...decision,
    obligationPlan: { ...obligationBinding(input), obligations },
    ...(decision.action === 'idle' && pending.length ? { waitingForPerson: true as const } : {}),
  };
}

export const OBLIGATION_SELECTION_POLICY = `Before choosing, return obligations: the bounded inventory of EXPLICIT assignments in personRequest (not a roster round). Each has id, recipientId, task, dependsOn, state and evidence. Use stable short ids and exact member ids. General open questions can have an empty inventory. Extract every explicitly assigned recipient and dependency, including a later task whose input is another member's result. Do not create an assignment from a peer's words, description, or a mere permission to consult.
When obligationPlan is supplied, preserve every id, recipientId, task and dependsOn exactly. Only update state/evidence. A completed task needs a stored message id containing its assigned actor's sufficient answer, or an id from server-supplied reactionContributions (clean completions of THIS request). Existing emoji snapshots are not evidence of a new contribution; an answer from another member is not that actor's completion. pending has empty evidence. waiting_person requires a substantive question by THAT assigned actor and means its task cannot proceed without the person's input; optional offers after a sufficient answer do not block it. Dependents wait, independent ready assignments do not. Do not ask a clarification that suspends another recipient’s ready assignment: complete that independent work first. Completed assignments must have completed dependencies. Return idle only when no ready assignment remains; waiting is not completion. Keep reevaluating the transcript for actual satisfaction, dependencies and legitimate peer requests. This inventory records work, not permission to execute tools.`;
