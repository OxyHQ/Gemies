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
 *
 * A message is whatever Telegram carried (`lib/channel-messages.ts`): its media is kept in the Oxy
 * Files of the person who connected the bot, whose conversation it is, and a voice note is
 * transcribed on the account whose turn it is (theirs for their own turn, the gemie's for a third
 * party's). An edit updates the stored message and is not answered again. In a third party's turn
 * the gemie may react to the message with an emoji (`channels/reaction-tool.ts`).
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
import {
  type GemieTelegramBotAnswer,
  type GemieTelegramBotMessage,
  turnContentText,
} from '@gemies/server/internal';
import { findAgentById } from '../db/agents/agentRepository.js';
import {
  findClientMessageContent,
  listRecentTurns,
  replaceChannelMessageWords,
} from '../db/chat/messageRepository.js';
import { channelReplyMessageId, type MessageContent } from '../domain/conversation.js';
import { prepareChannelTurn } from './channel-messages.js';
import { buildPersonalAccessTool, PERSONAL_ACCESS_TOOL } from './channels/personal-access-tool.js';
import { buildReactionTool, REACT_TOOL } from './channels/reaction-tool.js';
import { publishGemieChanged } from './realtime/account.js';
import { startActorActivity, type ActorActivity } from './realtime/activity.js';
import { publishConversation } from './realtime/conversations.js';
import { appendConversationMessages } from './conversation-saver.js';
import { getDb } from '../db/index.js';
import {
  claimGemieBotLinkCode,
  claimGemieBotTurn,
  type GemieBotRow,
  type GemieBotTurnClaim,
  type GemieBotTurnKey,
  readGemieBotTurn,
  recordGemieBotMessage,
  settleGemieBotTurn,
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

/** The id a Telegram message is stored under in its conversation, so an edit finds it again. */
export function botMessageClientId(chatId: string, messageId: string): string {
  return `telegram:${chatId}:${messageId}`;
}

/** Who wrote a message, as the gemie reads it. */
function speakerOf(message: GemieTelegramBotMessage): string {
  return message.from.username
    ? `${message.from.name} (@${message.from.username})`
    : message.from.name;
}

/** A person edited a message the conversation keeps: its words follow. Nothing is answered. */
async function onEdited(bot: GemieBotRow, message: GemieTelegramBotMessage): Promise<void> {
  const turn = await prepareChannelTurn({
    message: message.message,
    owner: null,
    payerAccountId: bot.userId,
    speaker: message.chatKind === 'group' ? speakerOf(message) : undefined,
    keep: false,
  });
  const besideFiles = turn.content[0]?.type === 'text' ? turn.content[0].text : '';
  const alone = turn.modelParts[0]?.type === 'text' ? turn.modelParts[0].text : besideFiles;
  const conversationId = botConversationId(bot, message.chatId);
  const changed = await replaceChannelMessageWords(
    getDb(),
    {
      oxyUserId: bot.userId,
      conversationId,
      clientMessageId: botMessageClientId(message.chatId, message.messageId),
    },
    { alone, besideFiles },
  );
  if (changed) void publishConversation(bot.userId, conversationId, { reload: true });
}

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

/** How long one attempt holds a message's turn before another instance may take it over. */
const TURN_LEASE_MS = 10 * 60_000;
/**
 * How long a turn may run: it ends before its lease does, so an attempt that takes the turn over
 * once the lease runs out never runs (and bills) beside it.
 */
const TURN_RUN_MS = TURN_LEASE_MS - 60_000;
/** How long a retry waits for an attempt still running before it answers nothing. */
const TURN_WAIT_MS = 200_000;
const TURN_POLL_MS = 1_000;

/** Said when a turn failed; kept as its answer, so a retry says it too rather than run again. */
export const TURN_FAILED_REPLY = 'Sorry, something went wrong. Please try again.';

/**
 * What the gemie answers: a reply, the person's own turn, or nothing (`reply: null`).
 *
 * A message's turn runs ONCE (`gemie_bot_turns`): the integrations process retries a delivery it
 * did not get an answer to (a timeout, a restart), and every retry used to run the turn again and
 * post another reply. A retry while it runs waits for it; one after it gets the same answer, which
 * that retry then delivers, since the attempt it repeats delivered nothing.
 */
export async function answerGemieTelegramMessage(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
): Promise<GemieTelegramBotAnswer> {
  if (!botAnswers(bot, message)) return { reply: null };
  if (message.edited) {
    await onEdited(bot, message);
    return { reply: null };
  }
  const db = getDb();
  const key = { botId: bot.botId, chatId: message.chatId, messageId: message.messageId };
  const claim = await claimGemieBotTurn(db, key, TURN_LEASE_MS);
  if (claim.kind !== 'claimed') return earlierAnswer(bot, message, key, claim);
  let answer: GemieTelegramBotAnswer;
  try {
    answer = await runTurn(bot, message);
  } catch (error: unknown) {
    await settleGemieBotTurn(db, key, { reply: TURN_FAILED_REPLY }).catch(() => undefined);
    throw error;
  }
  await settleGemieBotTurn(db, key, answer as unknown as Record<string, unknown>);
  return answer;
}

/**
 * A retry's answer: the earlier attempt's, once it settles. A person's turn runs through the chat
 * route, which stores its reply under an id derived from their message's: once that reply is
 * stored, the turn is not run again, and the retry delivers that reply, since the attempt it
 * repeats may have stopped before it did.
 */
async function earlierAnswer(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
  key: GemieBotTurnKey,
  claim: GemieBotTurnClaim,
): Promise<GemieTelegramBotAnswer> {
  const db = getDb();
  let state = claim;
  const deadline = Date.now() + TURN_WAIT_MS;
  while (state.kind === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS));
    state = await readGemieBotTurn(db, key);
  }
  // Still running at the deadline: the attempt holding it may have died with it, which only its
  // lease tells. Settled with no answer, the message would go unanswered for good; tried again
  // later, the retry takes the turn over once the lease runs out.
  if (state.kind !== 'answered') return { reply: null, retryLater: true };
  const answer = state.answer as unknown as GemieTelegramBotAnswer;
  // Answered is THIS message's reply being stored, never how the conversation ends: their next
  // message may already have arrived after it, and the conversation then ends in theirs again.
  const turn = answer.personTurn;
  if (!turn) return answer;
  // Theirs only while they are still its person: a Telegram unlinked since gets nothing of it.
  if (!isPersonTurn(bot, message)) return { reply: null };
  const replyId = channelReplyMessageId(turn.messageId);
  const replied = replyId
    ? await findClientMessageContent(db, bot.userId, turn.conversationId, replyId)
    : undefined;
  if (replied) {
    const text = turnContentText(replied.content).trim();
    return { reply: text || null };
  }
  return answer;
}

/** The turn itself, run once per message. */
async function runTurn(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
): Promise<GemieTelegramBotAnswer> {
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

  const start = message.chatKind === 'direct' ? startCommandOf(message.message.text) : null;
  if (start?.code) {
    const claimed = await claimGemieBotLinkCode(db, {
      botId: bot.botId,
      codeHash: createHash('sha256').update(start.code).digest('hex'),
      telegramUserId: message.from.id,
      telegramName: message.from.username ? `@${message.from.username}` : message.from.name,
    });
    if (claimed) {
      log.channels.info({ botId: bot.botId }, 'A gemie bot person linked their Telegram');
      // The editor shows who is linked as soon as it happens, on every device.
      void publishGemieChanged(bot.userId, bot.agentId, 'updated').catch(() => undefined);
    }
    return { reply: claimed ? said.linked(name) : said.expired(steps) };
  }
  if (isPersonTurn(bot, message)) {
    if (start) return { reply: said.hello(name) };
    // Their turn, with what they sent kept and transcribed as theirs, as an attachment in the app:
    // kept under the task they granted the gemie here (`isPersonTurn` holds only while it stands).
    const turn = await prepareChannelTurn({
      message: message.message,
      owner: bot.oxyTaskId ? { oxyUserId: bot.userId, taskId: bot.oxyTaskId } : null,
      payerAccountId: bot.userId,
    });
    // Shown in the app the moment it arrives, not once the gemie has answered: the chat route's
    // turn then appends only its reply after it (`conversation-saver.ts`).
    await keepArrivedMessage(bot, message, turn.content, agent._id, conversationId);
    return {
      reply: null,
      personTurn: {
        conversationId,
        messageId: botMessageClientId(message.chatId, message.messageId),
        content: turn.content,
      },
    };
  }
  if (start) return { reply: said.helloStranger(name, steps) };
  return answerAsThirdParty(bot, message, agent, conversationId);
}

/** A third party's turn: the gemie's own, with nothing of anybody's. */
async function answerAsThirdParty(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
  agent: HydratedAgent,
  conversationId: string,
): Promise<GemieTelegramBotAnswer> {
  const db = getDb();
  const agentAccountId = gemieOxyAccountId(agent);
  if (!agentAccountId) return { reply: null };
  const resolved = await resolveStoredModel(agent.modelId).catch(() => null);
  if (!resolved) return { reply: 'Sorry, no AI models are available right now.' };

  await getOrCreateUserCredits(bot.userId);
  const funding = await reserveAgentTurn({
    agentAccountId,
    ownerUserId: bot.userId,
    ownerFallbackAllowed: bot.ownerPaysAgentTurns,
  });
  if (!funding.ok) {
    const name = agentPromptName(agent);
    return {
      reply:
        funding.reason === 'owner_fallback_not_authorised'
          ? `${name} is not available here yet: whoever connected this bot has not allowed it to use their credits.`
          : `${name} is not available right now: it is out of credits.`,
    };
  }
  const reservation: CreditReservation = funding.reservation;
  let settled = false;
  let activity: ActorActivity | null = null;

  try {
    const speaker = speakerOf(message);
    const history = await listRecentTurns(db, bot.userId, conversationId, 20).catch(
      (error: unknown) => {
        log.channels.error({ err: error }, 'Could not read a Telegram bot conversation');
        return [];
      },
    );
    // In a group several people speak, so each message says who wrote it. Nothing they sent is
    // stored as the bot's person's file: the person's authority is for their own turns, and is
    // never inferred from owning the bot. The gemie sees it now; the conversation keeps its words.
    const turn = await prepareChannelTurn({
      message: message.message,
      owner: null,
      payerAccountId: agentAccountId,
      speaker: message.chatKind === 'group' ? speaker : undefined,
      modelAcceptsFiles: resolved.catalogue?.inputModalities.includes('file') === true,
    });
    // In the app the moment it arrives, with the gemie shown typing until its answer lands.
    await keepArrivedMessage(bot, message, turn.content, agent._id, conversationId);
    activity = startActorActivity({
      oxyUserId: bot.userId,
      conversationId,
      agentId: agent._id,
      name: agentPromptName(agent),
    });
    activity.set('thinking');
    const where =
      message.chatKind === 'group'
        ? `You are in the Telegram group "${message.chatTitle ?? 'a group'}", where you answer only when someone mentions you or replies to you. Each message says who wrote it.`
        : `You are in a private Telegram chat with ${speaker}, who may be anyone.`;
    // Honest about what is missing here, and how the one person who can change it does so.
    // Honest about how it becomes possible, from a tool rather than a sentence the model may not
    // follow: asked for "mi email", it used to answer that the capability does not exist.
    const reach = `In this turn your person's apps (email, calendar, files, connected accounts, memory, scheduling) are not reachable. When someone asks for any of them, call ${PERSONAL_ACCESS_TOOL} and tell them what it answers; never say the capability does not exist.`;
    const personalAccess = buildPersonalAccessTool({
      name: agentPromptName(agent),
      linkSteps: saidTo(message.from).steps(agentPromptName(agent)),
      personLinked: bot.linkedTelegramUserId !== null && bot.oxyTaskId !== null,
      chatKind: message.chatKind,
    });

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
    const reaction = buildReactionTool();
    const answered = await generateAnswered({
      model: getAIModel(resolved, 'agent_run'),
      system: `${buildIdentityGuard({ agentName: agentPromptName(agent) })}\n\n---\n\n${agentRemitPrompt(agent)}${await agentSpacePrompt(agent)}\n\n${DEFAULT_CHANNEL_PROMPT}\n\n${where}\n\n${reach}${appCatalogPrompt}`,
      messages: [
        ...history.map((turn) => ({
          role: turn.role as 'user' | 'assistant',
          content: turn.content,
        })),
        { role: 'user' as const, content: turn.modelParts },
      ],
      tools: {
        ...tools,
        [REACT_TOOL]: reaction.tool,
        [PERSONAL_ACCESS_TOOL]: personalAccess,
      },
      ...routing,
      maxOutputTokens: 2048,
      stopWhen: stepBudget(5),
      abortSignal: AbortSignal.timeout(TURN_RUN_MS),
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
    // Appended after the conversation's last message, with its `seq`: the person's own turns in
    // the same chat run through the chat route's saver, which continues from there.
    await appendConversationMessages<MessageContent>({
      userId: bot.userId,
      conversationId,
      agentId: agent._id,
      titleOnInsert: `Telegram · ${message.chatKind === 'group' ? (message.chatTitle ?? 'Group') : speaker}`,
      source: 'telegram',
      messages: reply ? [{ id: randomUUID(), role: 'assistant' as const, content: reply }] : [],
    });
    await recordGemieBotMessage(db, bot.id);
    return { reply: reply || null, reaction: reaction.chosen() };
  } finally {
    activity?.end();
    if (!settled) await safeRefund(reservation, 'Telegram bot turn ended without charging');
  }
}

/** The message that arrived, stored in its conversation at once (and so on every open app). */
async function keepArrivedMessage(
  bot: GemieBotRow,
  message: GemieTelegramBotMessage,
  content: MessageContent,
  agentId: string,
  conversationId: string,
): Promise<void> {
  const speaker = speakerOf(message);
  await appendConversationMessages<MessageContent>({
    userId: bot.userId,
    conversationId,
    agentId,
    titleOnInsert: `Telegram · ${message.chatKind === 'group' ? (message.chatTitle ?? 'Group') : speaker}`,
    source: 'telegram',
    messages: [
      { id: botMessageClientId(message.chatId, message.messageId), role: 'user', content },
    ],
  });
}
