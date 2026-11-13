/**
 * The real world a voice call runs in. `VoiceCall` takes it as an argument so
 * its suites can run the whole call against the Kaana fake and in-memory
 * stores; this is the one place the production modules are wired together.
 */

import { getDb } from '../../db/index.js';
import { insertChatAnalytics } from '../../db/usage/chatAnalyticsRepository.js';
import { prefetchTurnInputs } from '../chat/turn-inputs.js';
import { appendConversationMessages, generateConversationTitle } from '../conversation-saver.js';
import { getKaanaClient } from '../kaana/transport.js';
import type { VoiceCallEnvironment } from './call.js';
import { finishCall, startCall } from './call-registry.js';
import { buildVoiceTurn, loadConversationHistory } from './turn.js';

export function createVoiceEnvironment(accountId: string): VoiceCallEnvironment {
  return {
    kaana: getKaanaClient(accountId),
    prefetch: prefetchTurnInputs,
    startCall,
    finishCall,
    loadHistory: loadConversationHistory,
    buildTurn: buildVoiceTurn,
    persist: appendConversationMessages,
    titleConversation: (oxyUserId, conversationId, firstUserText) => {
      void generateConversationTitle(oxyUserId, conversationId, firstUserText);
    },
    recordAnalytics: (record) =>
      insertChatAnalytics(getDb(), {
        oxyUserId: record.oxyUserId,
        conversationId: record.conversationId,
        requestedModelId: 'voice',
        reasoningEffort: null,
        model: record.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: record.latencyMs,
        timeToFirstTokenMs: null,
        errorClass: record.errorClass,
        cancelled: false,
        resolvedModelReference: record.resolvedModelReference,
        platform: 'voice',
        skillNames: [],
      }),
  };
}
