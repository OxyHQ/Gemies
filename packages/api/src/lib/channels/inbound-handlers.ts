import { reserveBackgroundProductCredits } from '../product-credit-access';
import crypto from 'node:crypto';
import { generateText } from 'ai';
import { resolveStoredModel, getAIModel, type ResolvedModel } from '../chat-core.js';
import { sendChannelMessage } from '../channels/outbound.js';
import { buildIdentityGuard } from '../identity-guard.js';
import { DEFAULT_CHANNEL_PROMPT } from './channel-prompt.js';
import { getDb } from '../../db/index.js';
import {
  setBotUserAuthToken,
  setBotUserConversation,
  type BotUserRow,
} from '../../db/integrations/botRepository.js';
import { upsertConversation } from '../../db/chat/conversationRepository.js';
import { insertMessages, listRecentTurns } from '../../db/chat/messageRepository.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import {
  finalizeCredits,
  safeRefund,
  type CreditReservation,
  type CreditUsage,
} from '../credits-manager.js';
import type { ChannelId, ChannelInboundMessage } from '../channels/types.js';
import { log } from '../logger.js';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie.js';
import { servedModelId, servedReferenceOf } from '../models/power-levels.js';

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Answer one inbound message on the shared system bot, and bill the linked
 * account for it.
 *
 * EXPORTED because the route drops this promise on the floor: it acks the
 * platform (Slack gives it three seconds) and calls this fire-and-forget. There
 * is no response to inspect and no caller to await, so a test that drives the
 * route observes nothing about what happens in here — including whether the
 * credit it reserved came back.
 */
export async function processChannelMessage(
  channelType: ChannelId,
  botUser: BotUserRow,
  message: ChannelInboundMessage,
): Promise<void> {
  const db = getDb();
  /**
   * Out here so the `finally` can see them, and `creditsSettled` so no exit can
   * both charge and refund.
   *
   * `reserveCredits` DEBITS on the way in, and this handler has several exits
   * that answer a problem by messaging the person and returning — no model
   * available, an exception anywhere. Each one used to keep the credit. Nothing
   * reported it: the route acked the platform long before any of this ran, so
   * the only trace was a balance one lower than it should have been.
   *
   * The same release `routes/v1/chat-completions.ts` puts in ONE `finally`, for
   * the same reason: an exit that has to remember is an exit that will forget.
   */
  let creditReservation: CreditReservation | null = null;
  let creditsSettled = false;
  try {
    // Check if user has linked their Alia account
    if (!botUser.isLinked || !botUser.oxyUserId) {
      // Generate auth token and send auth link
      const authToken = generateAuthToken();
      await setBotUserAuthToken(db, botUser.id, authToken, new Date(Date.now() + 15 * 60 * 1000));

      const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
      const authUrl = `${apiBaseUrl}/bots/internal/${channelType}/verify?token=${authToken}`;

      await sendChannelMessage(
        channelType,
        message.chatId,
        `Hi! To use Alia, please link your account first:\n${authUrl}\n\nThis link expires in 15 minutes.`,
        { replyToId: message.replyToId, threadId: message.threadId },
      );
      return;
    }

    const userId = botUser.oxyUserId.toString();
    /**
     * The chat's stored model preference — a `publisher/model` written by
     * `packages/integrations`' `/model` command, shared through
     * `bot_users.preferred_model` — or the person's default when it is unset or
     * the catalogue no longer offers it (ADR 0012).
     */
    let resolved: ResolvedModel;
    try {
      resolved = await resolveStoredModel(botUser.preferredModel);
    } catch (error: unknown) {
      log.channels.warn({ err: error }, 'No model available for a bot message');
      await sendChannelMessage(
        channelType,
        message.chatId,
        'Sorry, no AI models are available right now.',
        {
          replyToId: message.replyToId,
          threadId: message.threadId,
        },
      );
      return;
    }
    const modelId = resolved.modelId;

    // Reserve credits before processing
    await getOrCreateUserCredits(userId);

    creditReservation = await reserveBackgroundProductCredits(userId);
    if (!creditReservation) {
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'https://alia.onl';
      await sendChannelMessage(
        channelType,
        message.chatId,
        `You've run out of credits. Add more at ${appUrl} to continue using Alia.`,
        { replyToId: message.replyToId, threadId: message.threadId },
      );
      return;
    }

    // Load or create conversation
    let conversationId = botUser.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      await setBotUserConversation(db, botUser.id, conversationId);
    }

    /**
     * Load conversation history.
     *
     * `listRecentTurns` narrows to string bodies in the DATABASE, so a
     * multi-part message is dropped rather than rendered as an empty line. Only
     * this path writes these threads and it writes strings, so nothing that
     * exists today is affected.
     */
    let messages: Array<{ role: string; content: string }> = [];
    try {
      messages = [...(await listRecentTurns(db, botUser.oxyUserId, conversationId, 20))];
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Failed to load conversation history');
    }

    // Add the new user message, stamped when it ARRIVED — see the write below.
    const userMessageAt = new Date();
    messages.push({ role: 'user', content: message.text });

    const model = getAIModel(resolved, 'agent_run');

    /**
     * The SHARED system bot, and the seventh composition path.
     *
     * The identity guard is what stands between a stranger's DM and a provider
     * name: the channel prompt below describes style and names nobody.
     *
     * The base identity: this bot is Alia's own. `findSystemBot` is what
     * selected it upstream — the row with no owner. A gemie's own bot is
     * `lib/gemie-telegram-bot.ts`, which passes that gemie's name.
     */
    const systemPrompt = `${buildIdentityGuard()}\n\n---\n\n${DEFAULT_CHANNEL_PROMPT}`;
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const fullResponse = result.text;

    // Finalize credits based on actual token usage
    const tokenUsage: CreditUsage = {
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
    };

    try {
      await finalizeCredits(
        creditReservation,
        tokenUsage,
        servedModelId(modelId, servedReferenceOf(result)),
      );
      // Only once the charge returned. A finalize that threw leaves the
      // reservation unsettled, and therefore refunded by the `finally`.
      creditsSettled = true;
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Error finalizing credits');
    }

    // Send response back via outbound adapter
    if (fullResponse) {
      await sendChannelMessage(channelType, message.chatId, fullResponse, {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
    }

    // Save conversation metadata + append messages
    if (fullResponse) {
      await upsertConversation(db, {
        oxyUserId: botUser.oxyUserId,
        conversationId,
        lastMessage: fullResponse.slice(0, 100),
        titleOnInsert: message.text.slice(0, 50),
        source: channelType,
        agentId: ALIA_GEMIE_ID,
      });

      /**
       * The two turns carry the times they actually happened — the user's when
       * the update arrived, the assistant's now — rather than one `new Date()`
       * for both.
       *
       * These rows carry no `seq` (the append-ordering column), so `created_at`
       * IS the order they are read back in, and two identical timestamps leave
       * that order undefined.
       * The values are not invented to break a tie: they are when each message
       * exists, and a model call sits between them.
       */
      await insertMessages(db, [
        {
          conversationId,
          oxyUserId: botUser.oxyUserId,
          role: 'user',
          content: message.text,
          createdAt: userMessageAt,
        },
        {
          conversationId,
          oxyUserId: botUser.oxyUserId,
          role: 'assistant',
          content: fullResponse,
          createdAt: new Date(),
        },
      ]);
    }
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Chat processing error');
    try {
      await sendChannelMessage(
        channelType,
        message.chatId,
        'Sorry, an error occurred. Please try again.',
        {
          replyToId: message.replyToId,
          threadId: message.threadId,
        },
      );
    } catch {
      /* ignore send errors */
    }
  } finally {
    // The one place this handler's reservation is released.
    if (creditReservation && !creditsSettled) {
      await safeRefund(creditReservation, 'inbound message ended without charging');
    }
  }
}
