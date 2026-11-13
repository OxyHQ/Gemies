/**
 * A gemie's own Telegram bot (ADR 0037 and its amendment): what the gemie answers to a message the
 * bot received.
 *
 * The integrations process speaks Telegram and asks here (`routes/channel-bots.ts`); this decides
 * whether the gemie answers and whose turn it is, and keeps the chat as one of the gemie's
 * conversations for the person who connected the bot. There are two kinds of sender:
 *
 *  - **The bot's person**, writing in private from the Telegram account they linked to it with a
 *    one-time `/start <code>` from the gemie's editor. Their turn is theirs, exactly as in the app:
 *    this answers `personTurn`, and the integrations process runs it through `POST /alia/chat` as
 *    the verified `gemie_bot` channel identity (their tools, memory, skills, authority and credits).
 *  - **Anybody else** — a stranger, or the person in a group, where others read the answer. A third
 *    party: the turn runs here as the gemie's own, with no personal tools, memory or Oxy authority
 *    of anyone's, and the prompt says how the person links their Telegram when someone asks for
 *    their data. Who pays is {@link reserveAgentTurn}'s: the gemie's own balance first, then the
 *    person who connected the bot when they allowed it (`bots.owner_pays_agent_turns`).
 */

import { generateAnswered } from './chat/tool-synthesis.js';
import { getAIModel, resolveStoredModel } from './chat-core.js';
import { agentPromptName, attachAgentIdentity, type HydratedAgent } from './agent-identity.js';
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
import { createHash, randomUUID } from 'node:crypto';
import type { GemieTelegramBotAnswer, GemieTelegramBotMessage } from '@gemies/server/internal';
import { findAgentById } from '../db/agents/agentRepository.js';
import { listRecentTurns } from '../db/chat/messageRepository.js';
import { appendConversationMessages } from './conversation-saver.js';
import { getDb } from '../db/index.js';
import {
  claimGemieBotLinkCode,
  recordGemieBotMessage,
  type GemieBotRow,
} from '../db/integrations/gemieBotRepository.js';
import { botConversationId, isPersonTurn } from '../domain/gemie-bot-person.js';

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

export { botConversationId };

/** Whether the gemie answers this message at all, before anything is spent on it. */
export function botAnswers(
  bot: Pick<GemieBotRow, 'groupReplies'>,
  message: Pick<GemieTelegramBotMessage, 'chatKind' | 'mentionsBot'>,
): boolean {
  if (message.chatKind === 'direct') return true;
  return bot.groupReplies === 'mentions' && message.mentionsBot;
}

/** `/start`, with the editor's one-time link code when it came from that link. */
export function startCommandOf(text: string): { code: string | null } | null {
  const start = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{16,64}))?\s*$/.exec(text.trim());
  return start ? { code: start[1] ?? null } : null;
}

/** The few things the bot says without a model, in the sender's language when Telegram tells it. */
const SAID = {
  en: {
    steps: (name: string) =>
      `in Gemies, open ${name} › Telegram bot › Link my Telegram, then open the link in Telegram`,
    linked: (name: string) =>
      `Linked. ${name} now recognises this Telegram account as yours: in this private chat it has your apps, accounts, memory and skills, and can schedule tasks, as in Gemies. In groups it stays itself.`,
    expired: (steps: string) =>
      `This link has expired or was already used. To get a new one, ${steps}.`,
    hello: (name: string) => `Hi! I'm ${name}. What can I do for you?`,
    helloStranger: (name: string, steps: string) =>
      `Hi! I'm ${name}. If you set me up, link your Telegram so I can use your apps here: ${steps}.`,
  },
  es: {
    steps: (name: string) =>
      `en Gemies, abre ${name} › Bot de Telegram › Vincular mi Telegram y abre el enlace en Telegram`,
    linked: (name: string) =>
      `Vinculado. ${name} reconoce ahora esta cuenta de Telegram como tuya: en este chat privado tiene tus apps, cuentas, memoria y skills, y puede programar tareas, igual que en Gemies. En los grupos sigue siendo solo él.`,
    expired: (steps: string) =>
      `Este enlace ha caducado o ya se usó. Para conseguir otro, ${steps}.`,
    hello: (name: string) => `¡Hola! Soy ${name}. ¿En qué te ayudo?`,
    helloStranger: (name: string, steps: string) =>
      `¡Hola! Soy ${name}. Si me configuraste tú, vincula tu Telegram para que pueda usar tus apps aquí: ${steps}.`,
  },
};

/** The bot's fixed copy for a sender. */
export function saidTo(from: Pick<GemieTelegramBotMessage['from'], 'languageCode'>) {
  return from.languageCode?.toLowerCase().startsWith('es') ? SAID.es : SAID.en;
}

/** What the gemie answers: a reply, the person's own turn, or nothing (`reply: null`). */
export async function answerGemieTelegramMessage(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
): Promise<GemieTelegramBotAnswer> {
  if (!botAnswers(bot, message)) return { reply: null };
  if (isSenderRateLimited(bot.botId, message.from.id)) {
    log.channels.info({ botId: bot.botId }, 'A Telegram sender was rate limited');
    return { reply: null };
  }

  const db = getDb();
  const found = await findAgentById(db, bot.agentId);
  if (!found) return { reply: null };
  // A gemie that runs on its own computer (ADR 0030/0036) has no account here to answer with.
  if (!gemieOxyAccountId(found)) return { reply: null };
  const agent = await attachAgentIdentity(found);
  const name = agentPromptName(agent);
  const said = saidTo(message.from);
  const steps = said.steps(name);
  const conversationId = botConversationId(bot, message.chatId);

  const start = message.chatKind === 'direct' ? startCommandOf(message.text) : null;
  if (start?.code) {
    const claimed = await claimGemieBotLinkCode(db, {
      botId: bot.botId,
      codeHash: createHash('sha256').update(start.code).digest('hex'),
      telegramUserId: message.from.id,
    });
    if (claimed)
      log.channels.info({ botId: bot.botId }, 'A gemie bot person linked their Telegram');
    return { reply: claimed ? said.linked(name) : said.expired(steps) };
  }
  if (isPersonTurn(bot, message)) {
    return start ? { reply: said.hello(name) } : { reply: null, personTurn: { conversationId } };
  }
  if (start) return { reply: said.helloStranger(name, steps) };
  return { reply: await answerAsThirdParty(bot, message, agent, conversationId) };
}

/** A third party's turn: the gemie's own, with nothing of anybody's. */
async function answerAsThirdParty(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
  agent: HydratedAgent,
  conversationId: string,
): Promise<string | null> {
  const db = getDb();
  const agentAccountId = gemieOxyAccountId(agent);
  if (!agentAccountId) return null;
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
    const where =
      message.chatKind === 'group'
        ? `You are in the Telegram group "${message.chatTitle ?? 'a group'}", where you answer only when someone mentions you or replies to you. Each message says who wrote it.`
        : `You are in a private Telegram chat with ${speaker}, who may be anyone.`;
    // Honest about what is missing here, and how the one person who can change it does so.
    const reach = `Here you act only as yourself: you cannot reach anybody's email, calendar, files, connected accounts or memory, and you cannot schedule anything. If someone asks for that, do not just say you have no access: say that ${agentPromptName(agent)} uses its person's apps only in their own private chat, once they link their Telegram (${SAID.en.steps(agentPromptName(agent))}), and answer in their language.${message.chatKind === 'group' ? ' In a group it never does, because everybody reads the answer.' : ''}`;

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
      system: `${buildIdentityGuard({ agentName: agentPromptName(agent) })}\n\n---\n\n${agentRemitPrompt(agent)}${await agentSpacePrompt(agent)}\n\n${DEFAULT_CHANNEL_PROMPT}\n\n${where}\n\n${reach}${appCatalogPrompt}`,
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
    // Appended after the conversation's last message, with its `seq`: the person's own turns in
    // the same chat run through the chat route's saver, which continues from there.
    await appendConversationMessages({
      userId: bot.userId,
      conversationId,
      agentId: agent._id,
      titleOnInsert: `Telegram · ${message.chatKind === 'group' ? (message.chatTitle ?? 'Group') : speaker}`,
      source: 'telegram',
      messages: [
        { id: randomUUID(), role: 'user', content: said },
        { id: randomUUID(), role: 'assistant', content: reply },
      ],
    });
    await recordGemieBotMessage(db, bot.id);
    return reply;
  } finally {
    if (!settled) await safeRefund(reservation, 'Telegram bot turn ended without charging');
  }
}
