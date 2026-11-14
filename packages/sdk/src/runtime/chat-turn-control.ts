import type { OxyServices } from '@oxy.so/core';
import { createRandomUuid } from './random-uuid';
import { awaitTurnPreparation } from './turn-preparation';

type LinkedClient = ReturnType<OxyServices['createLinkedClient']>;

/** One client turn, created before any asynchronous preparation or metadata. */
export function createChatTurnControl(
  linked: LinkedClient,
  headers: Promise<Record<string, string>>,
  conversationId: string | undefined,
  controller: AbortController,
) {
  // A host can reject before Stop is pressed. Observe that rejection immediately;
  // awaiting the original promise below still reports the failure to Stop.
  void headers.catch(() => undefined);
  const id = createRandomUuid();
  let stopping: Promise<void> | undefined;
  let ended = false;
  let markEnded!: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const lifetime = new AbortController();
  const epoch = linked.client.getSessionEpoch();
  const current = () => linked.client.getSessionEpoch() === epoch;
  const unsubscribe = linked.client.addTokenChangeListener(() => {
    if (!current()) {
      const reason = new Error('The conversation account changed');
      lifetime.abort(reason);
      controller.abort(reason);
    }
  });
  return {
    id,
    /** Settles once `finish()` has run: the turn's stream is over and nothing more will be written. */
    ended: endedPromise,
    /**
     * Only a deliberate Stop invokes this. View teardown merely aborts its transport.
     *
     * Resolves once the server has answered. Only an answer of `cancelled` cuts the stream here:
     * a turn already past its commit point (`finishing`, `completed`, `failed`) was not stopped,
     * and its stream carries it to its own end, stored. Await `ended` to know it is over.
     */
    stop(): Promise<void> {
      if (stopping) return stopping;
      if (ended || controller.signal.aborted) return Promise.resolve();
      stopping = (async () => {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);
        const assertionHeaders = await awaitTurnPreparation(headers, signal);
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        if (!current()) throw new Error('The conversation account changed');
        const response = await linked.client.requestAuthenticatedResponse({
          url: `/v1/chat/turns/${id}/cancel`,
          method: 'POST',
          headers: { ...assertionHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(conversationId ? { conversationId } : {}) }),
          // The cancelled chat signal must NOT cancel its own control request.
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Generation could not be stopped. Try again.');
        }
        const answer: unknown = await response.json().catch(() => null);
        if ((answer as { state?: unknown } | null)?.state === 'cancelled') controller.abort();
      })().catch((error) => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    },
    async finish() {
      ended = true;
      // The stream can close before the replica answering Stop sends its acknowledgement.
      await stopping?.catch(() => undefined);
      lifetime.abort();
      unsubscribe();
      linked.dispose();
      markEnded();
    },
  };
}

/** Public lifecycle handle for hosts that render their own Stop control. */
export type GemieChatTurnControl = ReturnType<typeof createChatTurnControl>;
