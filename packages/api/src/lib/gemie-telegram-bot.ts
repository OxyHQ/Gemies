/**
 * A gemie's own Telegram bot (ADR 0037): what the gemie answers to a message the bot received.
 *
 * The integrations process speaks Telegram and asks here (`routes/channel-bots.ts`); this decides
 * whether the gemie answers, runs its turn and keeps the chat as one of the gemie's conversations
 * for the person who connected the bot. Anyone on Telegram can write to the bot, so the turn is
 * the gemie's own, never the person's: no personal tools, memory or Oxy authority of theirs.
 *
 * Who pays is {@link reserveAgentTurn}'s: the gemie's own balance first, then the person who
 * connected the bot when they allowed it (`bots.owner_pays_agent_turns`).
 */

import { generateAnswered } from './chat/tool-synthesis.js';
import { getAIModel, resolveStoredModel } from './chat-core.js';
import { agentPromptName, attachAgentIdentity } from './agent-identity.js';
import { gemieOxyAccountId } from './gemie-oxy-actor.js';
import { agentRemitPrompt } from './agent/archetype-prompts.js';
import { agentSpacePrompt } from './agent/space-prompt.js';
import { reserveAgentTurn } from './agent/turn-funding.js';
import { DEFAULT_CHANNEL_PROMPT } from './channels/channel-prompt.js';
import { finalizeCredits, safeRefund, type CreditReservation } from './credits-manager.js';
import { buildIdentityGuard } from './identity-guard.js';
import { log } from './logger.js';
import { servedModelId, servedReferenceOf } from './models/power-levels.js';
import { stepBudget } from './tool-budget.js';
import { ToolPipeline } from './tool-pipeline.js';
import { getOrCreateUserCredits } from './user-credits-helpers.js';
import type { GemieTelegramBotMessage } from '@gemies/server/internal';
import { findAgentById } from '../db/agents/agentRepository.js';
import { upsertConversation } from '../db/chat/conversationRepository.js';
import { insertMessages, listRecentTurns } from '../db/chat/messageRepository.js';
import { getDb } from '../db/index.js';
import { recordGemieBotMessage, type GemieBotRow } from '../db/integrations/gemieBotRepository.js';

/**
 * Per-(bot, sender) limit. The bot is public and its turns are paid, so one sender flooding it
 * is dropped silently; credits stay the hard cap either way. Per instance, which is enough to stop
 * a single flood.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_SENDER = 15;
const recentBySender = new Map<string, number[]>();

export function isSenderRateLimited(botId: string, senderId: string, now = Date.now()): boolean {
  const key = `${botId}:${senderId}`;
  const recent = (recentBySender.get(key) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
  const limited = recent.length >= RATE_MAX_PER_SENDER;
  if (!limited) recent.push(now);
  if (recent.length) recentBySender.set(key, recent);
  else recentBySender.delete(key);
  return limited;
}

const sweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, hits] of recentBySender) {
    if (!hits.some((at) => at > cutoff)) recentBySender.delete(key);
  }
}, RATE_WINDOW_MS);
sweep.unref?.();

/** The conversation a Telegram chat of a bot is: one per chat, private or group. */
export function botConversationId(bot: Pick<GemieBotRow, 'botId'>, chatId: string): string {
  return `telegram:${bot.botId}:${chatId}`;
}

/** Whether the gemie answers this message at all, before anything is spent on it. */
export function botAnswers(
  bot: Pick<GemieBotRow, 'groupReplies'>,
  message: Pick<GemieTelegramBotMessage, 'chatKind' | 'mentionsBot'>,
): boolean {
  if (message.chatKind === 'direct') return true;
  return bot.groupReplies === 'mentions' && message.mentionsBot;
}

/** What the gemie answers, or `null` when it does not answer this message. */
export async function answerGemieTelegramMessage(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
): Promise<string | null> {
  if (!botAnswers(bot, message)) return null;
  if (isSenderRateLimited(bot.botId, message.from.id)) {
    log.channels.info({ botId: bot.botId }, 'A Telegram sender was rate limited');
    return null;
  }

  const db = getDb();
  const found = await findAgentById(db, bot.agentId);
  if (!found) return null;
  // A gemie that runs on its own computer (ADR 0030/0036) has no account here to answer with.
  const agentAccountId = gemieOxyAccountId(found);
  if (!agentAccountId) return null;
  const agent = await attachAgentIdentity(found);
  const resolved = await resolveStoredModel(agent.modelId).catch(() => null);
  if (!resolved) return 'Sorry, no AI models are available right now.';

  await getOrCreateUserCredits(bot.userId);
  const funding = await reserveAgentTurn({
    agentAccountId,
    ownerUserId: bot.userId,
    ownerFallbackAllowed: bot.ownerPaysAgentTurns,
  });
  if (!funding.ok) {
    const name = agentPromptName(agent);
    return funding.reason === 'owner_fallback_not_authorised'
      ? `${name} is not available here yet: whoever connected this bot has not allowed it to use their credits.`
      : `${name} is not available right now: it is out of credits.`;
  }
  const reservation: CreditReservation = funding.reservation;
  let settled = false;

  try {
    const conversationId = botConversationId(bot, message.chatId);
    const speaker = message.from.username
      ? `${message.from.name} (@${message.from.username})`
      : message.from.name;
    const history = await listRecentTurns(db, bot.userId, conversationId, 20).catch(
      (error: unknown) => {
        log.channels.error({ err: error }, 'Could not read a Telegram bot conversation');
        return [];
      },
    );
    // In a group several people speak, so each message says who wrote it.
    const said = message.chatKind === 'group' ? `${speaker}: ${message.text}` : message.text;
    const userMessageAt = new Date();
    const where =
      message.chatKind === 'group'
        ? `You are in the Telegram group "${message.chatTitle ?? 'a group'}", where you answer only when someone mentions you or replies to you. Each message says who wrote it.`
        : `You are in a private Telegram chat with ${speaker}, who may be anyone.`;

    const { tools, routing, appCatalogPrompt } = await ToolPipeline.forUser({
      userId: bot.userId,
      isDirectSession: false,
      // Whoever wrote is not the person who connected the bot: nothing of theirs is reachable.
      actsForPerson: false,
      requesterAccountId: null,
      inputLimits: resolved.catalogue,
      toolsEnabled: true,
      webSearch: true,
      isLocalRuntime: false,
      agent,
    });
    const answered = await generateAnswered({
      model: getAIModel(resolved, 'agent_run'),
      system: `${buildIdentityGuard({ agentName: agentPromptName(agent) })}\n\n---\n\n${agentRemitPrompt(agent)}${await agentSpacePrompt(agent)}\n\n${DEFAULT_CHANNEL_PROMPT}\n\n${where}${appCatalogPrompt}`,
      messages: [
        ...history.map((turn) => ({
          role: turn.role as 'user' | 'assistant',
          content: turn.content,
        })),
        { role: 'user' as const, content: said },
      ],
      tools,
      ...routing,
      temperature: 0.7,
      maxOutputTokens: 2048,
      stopWhen: stepBudget(5),
    });

    try {
      await finalizeCredits(
        reservation,
        {
          promptTokens: answered.usage.inputTokens,
          completionTokens: answered.usage.outputTokens,
          totalTokens: answered.usage.totalTokens,
        },
        servedModelId(resolved.modelId, servedReferenceOf(answered.last)),
      );
      settled = true;
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Could not charge a Telegram bot turn');
    }

    const reply = answered.text.trim();
    if (!reply) return null;
    await upsertConversation(db, {
      oxyUserId: bot.userId,
      conversationId,
      agentId: agent._id,
      lastMessage: reply.slice(0, 100),
      titleOnInsert: `Telegram · ${message.chatKind === 'group' ? (message.chatTitle ?? 'Group') : speaker}`,
      source: 'telegram',
    });
    // Distinct times: these rows are read back in `created_at` order.
    await insertMessages(db, [
      {
        conversationId,
        oxyUserId: bot.userId,
        role: 'user',
        content: said,
        createdAt: userMessageAt,
      },
      {
        conversationId,
        oxyUserId: bot.userId,
        role: 'assistant',
        content: reply,
        createdAt: new Date(),
      },
    ]);
    await recordGemieBotMessage(db, bot.id);
    return reply;
  } finally {
    if (!settled) await safeRefund(reservation, 'Telegram bot turn ended without charging');
  }
}
