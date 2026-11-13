/**
 * How a channel turn is answered: through the main API's `/alia/chat`, the same runtime as a turn
 * in the app (its system prompt, memory, tools, authority and billing), as a verified channel
 * identity. Shared by every account gateway (WhatsApp, Telegram Business: `handleIncomingMessage`)
 * and by a gemie's own bot when its person writes (ADR 0037 amendment: `answerThroughChat`).
 */

import { createHash } from 'node:crypto';
import {
  channelMessageIsEmpty,
  type GemieAccountInbound,
  type GemieChannelIdentity,
  type GemieChannelMessage,
} from '@gemies/server/internal';
import type { APIClient, MessageContent } from './api-client';
import { chunkText } from './utils';
import { createLogger } from './logger';

export interface IncomingMessageParams {
  platform: string;
  sessionId: string;
  /** Where it arrived, for the API to decide whether the account's gemie answers it. */
  inbound: GemieAccountInbound;
  /**
   * What the message is, in the shared channel-message model. Read only once the gemie answers
   * it, because reading downloads its media.
   */
  readMessage: () => Promise<GemieChannelMessage>;
  /** Send a response message back on this platform */
  sendResponse: (text: string) => Promise<void>;
  /** Show/hide typing indicator (best-effort) */
  setTyping?: (typing: boolean) => Promise<void>;
  /** Max chars per message (default 4000) */
  charLimit?: number;
  /** Custom system prompt suffix */
  platformContext?: string;
}

export async function handleIncomingMessage(
  params: IncomingMessageParams,
  apiClient: APIClient,
): Promise<void> {
  const { platform } = params;
  const logger = createLogger(`${platform}/Chat`);

  const identity = { kind: 'account' as const, sessionId: params.sessionId };
  // Who the gemie answers is the account's to say (ADR 0035): a chat it was not told to answer is
  // left alone — no reply, and no apology to a contact who never asked it anything.
  let answer = false;
  try {
    answer = (await apiClient.decideInbound(identity, params.inbound)).answer;
  } catch (error) {
    logger.warn('Could not ask whether to answer; leaving the message alone:', error);
  }
  if (!answer) return;

  try {
    // Stable within this connected channel conversation; the API separately binds its owner.
    const conversationId = createHash('sha256')
      .update(JSON.stringify([platform, params.sessionId, params.inbound.chatId]))
      .digest('hex');
    const message = await params.readMessage();
    if (channelMessageIsEmpty(message)) return;
    // Its media kept in the person's Oxy Files and its voice transcribed: the API's to do.
    const { content } = await apiClient.prepareAccountMessage(identity, {
      chatId: params.inbound.chatId,
      message,
    });
    await answerThroughChat({ ...params, identity, conversationId, content }, apiClient);
  } catch (error: unknown) {
    // Nothing is said in the chat: it is the person's own account writing to one of their
    // contacts, and an apology from it would be a message the person never wrote.
    logger.error('Error:', error);
  }
}

export interface ChatTurnParams {
  platform: string;
  identity: GemieChannelIdentity;
  /** The conversation the turn continues (and the API saves it to). */
  conversationId: string;
  /** The user message: text, or its words and kept media as `file` parts. */
  content: MessageContent;
  /** The id the user message is stored under, when the platform's message has one to keep. */
  messageId?: string;
  sendResponse: (text: string) => Promise<void>;
  setTyping?: (typing: boolean) => Promise<void>;
  /** Max chars per message (default 4000) */
  charLimit?: number;
  platformContext?: string;
}

/**
 * Run one turn through `/alia/chat` as `identity`, in `conversationId`, and send the answer back.
 * Throws when the turn fails: what to say about it is the caller's.
 */
export async function answerThroughChat(
  params: ChatTurnParams,
  apiClient: APIClient,
): Promise<void> {
  const {
    platform,
    identity,
    conversationId,
    content,
    sendResponse,
    setTyping,
    charLimit = 4000,
    platformContext = '',
  } = params;
  const logger = createLogger(`${platform}/Chat`);

  if (setTyping) {
    // Best-effort; a failure must not interrupt the reply.
    await setTyping(true).catch((error) => logger.debug('Failed to start typing:', error));
  }

  /**
   * The whole stored conversation, as the app sends it, each message's content as it is stored. The
   * API's saver appends the new turn when this history is exactly what it holds,
   * and otherwise rewrites the thread FROM it: a trimmed or reworded history would cut or rewrite
   * the thread. A channel turn reads only its new message's files; earlier ones are said in words.
   */
  let messages: Array<{ id?: string; role: string; content: MessageContent }> = [];
  try {
    const conversation = await apiClient.getConversation(identity, conversationId);
    if (conversation?.messages?.length) {
      messages = conversation.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));
    }
  } catch (error) {
    logger.error('Failed to load history:', error);
  }

  messages.push({ ...(params.messageId ? { id: params.messageId } : {}), role: 'user', content });

  // Platform instructions as first system message —
  // the API extracts this as clientContext and merges it into the full system prompt
  const apiMessages = [
    {
      role: 'system',
      content: `The user is chatting via ${platform}. Be concise and friendly.${platformContext ? ` ${platformContext}` : ''}`,
    },
    ...messages,
  ];

  const result = await apiClient.chatCompletion(identity, apiMessages, {
    // Unset, or no longer in the catalogue, means the request names no
    // model and the server's default applies. See `./catalogue.ts`.
    model: await apiClient.requestModel(undefined),
    conversationId,
  });

  if (result.content) {
    for (const chunk of chunkText(result.content, charLimit)) {
      await sendResponse(chunk);
    }
  }

  if (setTyping) {
    await setTyping(false).catch((error) => logger.debug('Failed to clear typing:', error));
  }
  // The conversation is saved by the API, since `conversationId` is given.
}
