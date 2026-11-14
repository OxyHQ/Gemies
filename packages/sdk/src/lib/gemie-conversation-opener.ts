import { createContext, useContext } from 'react';

/**
 * How a card in the thread opens a conversation between gemies (ADR 0041): the chat that draws it
 * shows the conversation read-only over itself (`GemieChatContent`). `null` outside a chat — a
 * shared conversation, for one — where the card opens nothing.
 */
const GemieConversationOpener = createContext<((conversationId: string) => void) | null>(null);

export const GemieConversationOpenerProvider = GemieConversationOpener.Provider;

export function useOpenGemieConversation(): ((conversationId: string) => void) | null {
  return useContext(GemieConversationOpener);
}
