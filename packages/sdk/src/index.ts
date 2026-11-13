/// <reference types="nativewind/types" />
// @gemies/sdk — the Gemies SDK
// Reusable chat UI, voice, and streaming components for Oxy apps

// ── Main components ──
export { GemieChatContent } from './components/GemieChatWithVoice';
export type {
  GemieChatAgentRef,
  GemieChatChrome,
  GemieChatContentProps,
  GemieChatState,
} from './components/GemieChatContent';
export { GemieParticipants, useParticipants } from './components/GemieParticipants';
export type {
  GemieParticipantsProps,
  UseParticipantsOptions,
} from './components/GemieParticipants';
export { GemieParticipantsHeader } from './components/GemieParticipantsHeader';
export type { GemieParticipantsHeaderProps } from './components/GemieParticipantsHeader';
export { ALIA_GEMIE_ID } from './lib/alia-gemie';
export { ALIA_LEAD, leadOf } from './lib/participants';
export type { GemieChatParticipants, GemieLead, GemieParticipant } from './lib/participants';
export { ANCHORS, leadToProfile } from './lib/flights';
export { parseCatalogueTool, toolRendererKey } from './lib/catalogue-tool';
export type { GemieToolRenderers, GemieToolResult } from './lib/tool-renderers';
export { GemieAskProvider, useAskGemie } from './components/GemieAskProvider';
export type {
  GemieAsk,
  GemieAskAgents,
  GemieAskProviderProps,
} from './components/GemieAskProvider';
export { GemieSharedConversation } from './components/GemieSharedConversation';
export type { GemieSharedConversationProps } from './components/GemieSharedConversation';
export type { GemieAddMenu } from './lib/add-menu';
export type { GemieVoiceOptions } from './hooks/useChatVoice';
export { GemieChatSheet } from './components/GemieChatWithVoice';
export type { GemieChatSheetProps, GemieChatSheetRef } from './components/GemieChatSheet';
export { GemieRecentConversations } from './components/GemieRecentConversations';
export type { GemieTurn } from './hooks/useChatComposer';
export { GemieChatScreen } from './components/GemieChatWithVoice';
export type { GemieChatScreenProps } from './components/GemieChatScreen';

// ── Chat UI components ──
export { DEFAULT_LABELS } from './lib/labels';
export { GemieChatLabelsProvider, useLabels } from './lib/labels';
export type { GemieChatLabels, VoiceBlockReason } from './lib/labels';
export { VoiceModeIcon } from './components/VoiceModeIcon';
export { AmbientField, PARALLAX_DURATION, PARALLAX_EASE } from './components/AmbientField';
export type { AmbientFieldProps } from './components/AmbientField';
export { ALIA_AVATAR, GemieAvatar } from './components/GemieAvatar';
export { DEFAULT_AGENT_CHARACTER, readAgentCharacter, readAgentLook } from './lib/agent-character';
export type { GemieAvatarProps, GemieAvatarState } from './components/GemieAvatar';
export { GemieAvatarIcon } from './components/GemieAvatarIcon';
export { useGemieActivity } from './hooks/useGemieActivity';
export type { UseGemieActivityOptions } from './hooks/useGemieActivity';
export { IdentityMark } from './components/IdentityMark';
export type { IdentityMarkProps, IdentityMarkState } from './components/IdentityMark';
export { ReplyMarkdown } from './components/ReplyMarkdown';
export { GemieThread } from './components/thread/GemieThread';
export type { GemieThreadProps, NewConversationOfferProps } from './components/thread/GemieThread';
export { ThoughtPanel } from './components/thought/ThoughtPanel';
export type { ThoughtPanelProps } from './components/thought/ThoughtPanel';
export type { OutputActions } from './components/thought/FilesAndSources';
export { CanvasComponent } from './components/canvas/CanvasComponent';
export { restoreOpenerFocus } from './lib/focus-return';
export { buildPowerLevelOptions, POWER_LEVEL_ICONS } from './lib/power-level-options';
export type { DeviceModel } from './lib/power-level-options';
export { GemieWelcomeMessage } from './components/GemieWelcomeMessage';
export { PlanPreviewCard } from './components/PlanPreviewCard';
export { AskedQuestions, QuestionCard } from './components/QuestionCard';
export { GemieComposer } from './components/GemieComposer';
export type {
  GemieComposerProps,
  GemieComposerQuestions,
  GemieComposerSuggestions,
} from './components/GemieComposer';
export { ComposerSuggestions } from './components/ComposerSuggestions';
export { usePendingQuestions } from './hooks/usePendingQuestions';
export { useComposerSuggestions, useSuggestionQuery } from './hooks/useComposerSuggestions';
export { composerCompletions } from './lib/suggestions';
export type { Completion } from './lib/suggestions';
export {
  ASK_USER_QUESTION_TOOL,
  askedQuestions,
  formatAnswers,
  isQuestionInvocation,
} from './lib/questions';
export type { AskedOption, AskedQuestion, QuestionAnswer } from './lib/questions';

// ── Conversation runtime: the one data layer under the sheet, the screen and the Alia app ──
export * from './runtime';

// ── Read aloud and dictation (no call, no audio engine) ──
export { useTTS } from './hooks/useTTS';
export type { UseTTSOptions } from './hooks/useTTS';
export { useDictation, useDictationStore } from './hooks/useDictation';
export type { UseDictationOptions, DictationState } from './hooks/useDictation';
export { DictationError, requestTranscription } from './lib/dictation';
export type { DictationErrorCode, TranscriptionResult } from './lib/dictation';
export { VOICE_ERROR_MESSAGES } from './lib/speech-messages';
export type { VoiceErrorCode } from './lib/speech-messages';
export { SpeechClipError } from './lib/speech-synthesis';
export type { SpeechClipErrorCode } from './lib/speech-synthesis';

// ── Types ──
export type {
  GemieAttachment,
  GemieSuggestion,
  ResearchProgress,
  ResearchSource,
  MessagePlan,
  PlanStep,
} from './types';

// ── Voice: part of the conversation screen; the host brings callbacks (see `GemieVoiceOptions`) ──
export type { VoiceNotice, VoiceSessionProps, VoiceSessionState } from './types';
export { GemieVoiceCall } from './components/voice/GemieVoiceCall';
export { useVoiceLauncher, toastNotice } from './hooks/useVoiceLauncher';
export type { UseVoiceLauncherOptions, VoiceLauncher } from './hooks/useVoiceLauncher';

// ── UI Primitives (NativeWind) ──
export { cn, formatFileSize } from './lib/utils';
export { getToolLabel, getToolActiveLabel, getResearchActiveLabel } from './lib/tool-registry';
export { getTextFromContent, getImagesFromContent } from './lib/content-utils';

// ── The turn's work log: tool calls as Bloom's `WebSearch` and `TaskList` ──
export { isWebInvocation, taskListLog, webSearchLog } from './lib/work-log';
export type { LiveResearch, TaskListLog, WebSearchLog, WorkLogOptions } from './lib/work-log';
// The pure parts (call status, citations, tool labels, `Translate`) are `@gemies/sdk/tools`.

// ── Picker hooks ──
export { useImagePicker } from './hooks/useImagePicker';
export type { ImagePickerAsset } from './hooks/useImagePicker';
export { useDocumentPicker } from './hooks/useDocumentPicker';
export type { DocumentPickerResult } from './hooks/useDocumentPicker';

// ── Keyboard ──
export { KeyboardAwareScrollView, KeyboardAvoidingView, KeyboardProvider } from './lib/keyboard';

// ── Theme ──
export type { GemieColors } from './theme';
