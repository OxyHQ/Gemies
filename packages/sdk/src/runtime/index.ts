/**
 * The conversation runtime: the data layer under the sheet, the screen and the Alia app.
 *
 * Layers, each depending only on the ones above it in this list:
 *
 *  1. transport — `api` (REST over the signed-in Oxy client), the turn's SSE stream
 *  2. model and state — `types`, the zustand stores, and the account's data (`data/*`): the
 *     conversations, their lists, the collections and the threads in the signed-in account's
 *     `@oxy.so/bloom-data` store, with the writes that change them
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
export {
  useGemieRealtime,
  useRealtimeEvent,
  useRealtimeReset,
  useRealtimeTopic,
} from '../realtime/react';
export { useConversationActivity } from '../realtime/activity';
export { GemieApiError, useGemieApi } from './api';
export {
  agentFeatures,
  agentProfile,
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
export {
  FEATURE_ENTITLEMENT_REQUIRED,
  parseMemberTurnEvent,
  parseHostAction,
} from './stream-events';
export type { MemberTurnAgent, MemberTurnEvent } from './stream-events';
export {
  DEFAULT_SHARE_TTL_HOURS,
  readSharedConversation,
  revokeConversationShare,
  shareConversation,
  SharedConversationGoneError,
  sharedConversation,
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
export {
  useClearConversation,
  useConversation,
  useConversations,
  useConversationsClient,
  useCreateConversation,
  useDeleteConversation,
  useMarkConversationRead,
  usePrefetchConversation,
  useRefreshConversation,
  useRenameConversation,
  useSaveConversation,
} from './conversations';
export type { ConversationsView } from './conversations';
// The account's data, for a host that reads or writes it beside the hooks (a sidebar).
export {
  clearConversation,
  ConversationList,
  ConversationMessages,
  ConversationNotFoundError,
  Conversations,
  conversation,
  conversationList,
  conversationsKey,
  createConversation,
  deleteConversation,
  fetchConversation,
  filterOfKey,
  forgetConversation,
  heldConversation,
  MAX_PERSISTED_BYTES,
  MAX_PERSISTED_CONVERSATIONS,
  MAX_PERSISTED_MESSAGES,
  markConversationRead,
  messagesRecord,
  matchesFilter,
  OfflineConversations,
  placeConversation,
  refreshConversationLists,
  renameConversation,
  saveConversation,
  trimConversationMessages,
} from './data/conversations';
export type {
  ConversationMessagesRecord,
  ConversationsClient,
  ConversationsFilter,
  CreateConversationInput,
  SaveConversationInput,
} from './data/conversations';
export {
  conversationCollections,
  createCollection,
  deleteCollection,
  importCollections,
  setCollectionMember,
  setConversationFavorite,
  setConversationPinned,
  storeCollections,
  updateCollection,
} from './data/collections';
export {
  gemieThread,
  retryThreadRead,
  ThreadHistory,
  threadHistory as threadHistorySource,
  ThreadMessages,
  threadSearch,
  ThreadWindow,
  threadWindow,
} from './data/threads';
export { answerSource, useAnswer } from './data/answer';
export type { Answer, AnswerSource, AnswerSourceOptions } from './data/answer';
export { ACCOUNT, gemieRead } from './data/read';
export { useConversationThread, mergeEditedContent } from './use-conversation-thread';
export { useCollectionActions, useConversationCollections } from './collections';
export type {
  CollectionActions,
  CollectionFields,
  ConversationCollection,
  ConversationCollectionKind,
  ConversationCollections,
  LocalCollections,
} from './collections';
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
export { useGemieThread, useRefreshGemieThread } from './use-gemie-thread';
export type { GemieThreadInfo } from './use-gemie-thread';
export { AGENT_ROUTES, threadKey } from './routes';
export type { GemieThreadAddress } from './routes';
export { useStartConversation } from './use-start-conversation';
export type { StartConversationOptions } from './use-start-conversation';
export { useTurnEdit } from './use-turn-edit';
export { buildMessageContent } from './attachment-utils';
export type { BuiltMessageContent, DroppedAttachment, UploadDocument } from './attachment-utils';

// The conversation as data (also the leaf entry `@gemies/sdk/model`).
export * from './model';

export { createChatTurnControl, type GemieChatTurnControl } from './chat-turn-control';
