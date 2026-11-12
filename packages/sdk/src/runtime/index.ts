/**
 * The conversation runtime: the data layer under the sheet, the screen and the Alia app.
 *
 * Layers, each depending only on the ones above it in this list:
 *
 *  1. transport — `api` (REST over the signed-in Oxy client), the turn's SSE stream
 *  2. model and state — `types`, `query-keys`, the zustand stores, the cached conversation lists
 *  3. hooks — `useConversations`…, `useConversationThread`
 *
 * Nothing here draws anything. It is also a leaf entry, `@gemies/sdk/runtime`, for a host that
 * needs the data layer without the chat UI (a sidebar, a test).
 */

export { GemieRuntimeProvider, useGemieRuntime } from './config';
export type {
  GemieArtifact,
  GemieRuntimeConfig,
  GemieRuntimeHost,
  GemieRuntimeProviderProps,
  GemieTurnRequest,
  GemieUsageFrame,
  OfflineConversationStore,
  SpeechPreferences,
  ThoughtOpening,
} from './config';
export type { RoomEvent } from './room-events';
export type { MessageReactionUpdate } from './message-reactions';
export { GemieApiError, useGemieApi } from './api';
export {
  GEMIE_FEATURES,
  featureOffer,
  readAgentFeatures,
  readAgentProfile,
  useAgentFeatures,
  useAgentProfile,
} from './agents';
export type {
  GemieAgentFeature,
  GemieAgentProfile,
  GemieAgentStarter,
  FeatureOffer,
} from './agents';
export {
  HOST_IMAGE_MEDIA_TYPES,
  HOST_IMAGE_TEXT_MAX_CHARS,
  HOST_OUTCOMES,
  HOST_RESULT_MAX_CHARS,
  HostOutcomeQueue,
  hostImageResultProblem,
  hostRequest,
} from './host-tools';
export type {
  GemieHostAction,
  GemieHostImageMediaType,
  GemieHostImageResult,
  GemieHostOutcome,
  GemieHostOutcomeKind,
  GemieHostToolDefinition,
  GemieHostTools,
  HostResultRecord as GemieHostResultRecord,
} from './host-tools';
export { FEATURE_ENTITLEMENT_REQUIRED, parseConsultEvent, parseHostAction } from './stream-events';
export type { ConsultAgent, ConsultEvent } from './stream-events';
export {
  DEFAULT_SHARE_TTL_HOURS,
  readSharedConversation,
  SharedConversationGoneError,
  sharedMessages,
  useShareConversation,
  useSharedConversation,
} from './sharing';
export { gemiesSharedConversationUrl } from '../lib/origins';
export type {
  GemieConversationShare,
  GemieSharedAgent,
  GemieSharedConversationData,
  GemieSharedMessage,
} from './sharing';
export { uploadToOxyFiles, useDocumentUpload } from './oxy-files';
export type { OxyFilesClient } from './oxy-files';
export type { GemieApi, GemieApiRequest, GemieApiResult } from './api';
export { gemieQueryKeys, type ConversationsFilter } from './query-keys';
export {
  ConversationNotFoundError,
  useClearConversation,
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  usePrefetchConversation,
  useRenameConversation,
  useSaveConversation,
} from './conversations';
export { useConversationThread, mergeEditedContent } from './use-conversation-thread';
export type {
  ConversationThread,
  EditedContent,
  UseConversationThreadOptions,
} from './use-conversation-thread';
export type { SendOutcome } from './use-conversation-stream';
export { useConversationStore } from './conversation-store';
export type { PendingInitialMessage } from './conversation-store';
export {
  releaseAttachments,
  useComposerDraft,
  useComposerDraftStore,
  useDraftAddress,
} from './composer-draft-store';
export type {
  ComposerDraft,
  DraftAddress,
  DraftTarget,
} from './composer-draft-store';
export { useAgentActivity } from './use-agent-activity';
export type { UseAgentActivityResult } from './use-agent-activity';
export { useThoughtStore } from './thought-store';
export type {
  ThoughtScope,
  ThoughtScopeStatus,
  ThoughtSelection,
  ThoughtTab,
} from './thought-store';
export { useThreadHistory } from './use-thread-history';
export { useThreadSearch, useThreadWindow } from './use-thread-search';
export { useGemieThread } from './use-gemie-thread';
export type { GemieThreadInfo } from './use-gemie-thread';
export type { GemieThreadAddress } from './routes';
export { useStartConversation } from './use-start-conversation';
export type { StartConversationOptions } from './use-start-conversation';
export { useTurnEdit } from './use-turn-edit';
export { buildMessageContent } from './attachment-utils';
export type { BuiltMessageContent, DroppedAttachment, UploadDocument } from './attachment-utils';

// The conversation as data (also the leaf entry `@gemies/sdk/model`).
export * from './model';

export { createChatTurnControl, type GemieChatTurnControl } from './chat-turn-control';
