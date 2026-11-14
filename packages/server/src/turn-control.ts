import type { GemieServerClient } from './client.js';

export interface GemieTurnControlOptions {
  /** Shared with this request's stream; a terminal SSE frame may abort it before Stop is acknowledged. */
  readonly controller: AbortController;
  /** Separate account/owner lifetime fence; never the stream's own signal. */
  readonly lifetimeSignal: AbortSignal;
  readonly conversationId?: string;
}

/**
 * One HTTP generation, created before asynchronous preparation. A tool continuation
 * is another generation and needs a fresh handle. The caller retains ownership of
 * its authenticated transport and must fence account changes through both the controller and lifetimeSignal.
 */
export function createGemieTurnControl(
  client: Pick<GemieServerClient, 'cancelTurn'>,
  options: GemieTurnControlOptions,
) {
  const id = globalThis.crypto.randomUUID();
  let pending: Promise<void> | undefined;
  let finished = false;
  return {
    id,
    /**
     * Acknowledged remote Stop, then detach. Failure leaves the stream available for retry.
     *
     * Only an answer of `cancelled` detaches: a generation already past its commit point
     * (`finishing`, `completed`, `failed`) was not stopped, and its stream carries it to its own
     * end, stored. Detaching it would report a stored answer as cancelled.
     */
    stop(): Promise<void> {
      if (pending) return pending;
      if (finished || options.controller.signal.aborted) return Promise.resolve();
      pending = client
        .cancelTurn(
          { turnId: id, conversationId: options.conversationId },
          { signal: AbortSignal.any([options.lifetimeSignal, AbortSignal.timeout(10_000)]) },
        )
        .then(({ state }) => {
          if (state === 'cancelled') options.controller.abort();
        })
        .catch((error) => {
          pending = undefined;
          throw error;
        });
      return pending;
    },
    /** Drain an outstanding acknowledgement before disposing the linked transport. */
    async finish(): Promise<void> {
      finished = true;
      await pending?.catch(() => undefined);
    },
  };
}

export type GemieTurnControl = ReturnType<typeof createGemieTurnControl>;
