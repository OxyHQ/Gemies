/**
 * Consumer-first rollout (ADR 0025): release 2 installs readers for durable authored reactions
 * and room v3 plans, but creates neither. Release 3 activates both only after release 2 is the
 * verified rollback baseline. This is a source release decision, never request data or an env flag.
 */
export const CONVERSATION_WRITE_VERSION: 2 | 3 = 3;

export function authoredReactionsEnabled(): boolean {
  return CONVERSATION_WRITE_VERSION >= 3;
}
