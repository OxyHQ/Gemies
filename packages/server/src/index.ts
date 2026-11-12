export {
  GEMIES_API_URL,
  GemieServerClient,
  createGemieServerClient,
  type GemieChatCompletionRequest,
  type GemieCancelTurnRequest,
  type GemieTurnCancellation,
  type GemieChatMessage,
  type GemieHeaders,
  type GemieServerClientOptions,
  type GemieStreamInit,
} from './client.js';

export {
  GemieAbortError,
  GemieRequestError,
  GemieStreamError,
  type GemieChunkShape,
  type GemieFailureDetail,
  type GemieStreamFailure,
} from './errors.js';

export type {
  GemieDoneEvent,
  GemieErrorEvent,
  GemieFinishEvent,
  GemieNamedEvent,
  GemieReasoningEvent,
  GemieStreamEvent,
  GemieTextEvent,
  GemieToolCallDelta,
  GemieToolCallsEvent,
} from './events.js';

export { readGemieEventStream, type ReadGemieEventStreamOptions } from './stream.js';
export {
  createGemieTurnControl,
  type GemieTurnControl,
  type GemieTurnControlOptions,
} from './turn-control.js';

export { GEMIES_APPLICATION_ID, GEMIES_SERVICE_AUDIENCE } from './identity.js';
export {
  createGemieForOxyService,
  createGemieTransportForOxyService,
  type OxyServiceTransportFactory,
  type GemieOxyRequester,
} from './oxy.js';
