import type { AccountGateway } from '../../accounts/gateway';
import { TelegramApiError } from '../bot-api';
import { sharedBot, sharedBotUsername } from '../bots';
import { sendText } from '../send';
import {
  createBusinessSession,
  currentLinkCode,
  deleteBusinessSession,
  findBusinessChat,
  findBusinessSessionOwner,
  listBusinessChats,
  listBusinessMessages,
  readBusinessSession,
  sessionReport,
  statusOf,
} from './repository';
import { sendAsAccount } from './send-as-account';

/** Telegram lets a business bot write in a private chat for 24 hours after the contact last did. */
const REPLY_WINDOW_SECONDS = 24 * 60 * 60;

/** The link a panel shows: it opens the shared bot with the session's one-time code. */
async function linkFor(code: string): Promise<string> {
  return `https://t.me/${await sharedBotUsername()}?start=${code}`;
}

function bot() {
  const api = sharedBot();
  if (!api) throw new Error('The shared Telegram bot is not configured');
  return api;
}

/**
 * Telegram Business through the shared Gemies bot (ADR 0037): the person opens the bot from the
 * panel's link and connects it in Telegram › Settings › Telegram Business › Chatbots. Telegram
 * Premium only, private chats only, and only what arrives once it is connected: the Bot API offers
 * no chat list and no history, so `chats` and `messages` are what this service has seen since.
 */
export const telegramBusinessGateway: AccountGateway = {
  platform: 'telegram',

  // The webhook and its updates are the Telegram layer's (`telegram/index.ts`); nothing to open.
  initialize: async () => {},
  shutdown: async () => {},
  ownerOf: findBusinessSessionOwner,

  async link(oxyUserId) {
    const { sessionId, linkCode } = await createBusinessSession(oxyUserId);
    return { sessionId, qr: await linkFor(linkCode) };
  },

  async qr(sessionId) {
    const state = await readBusinessSession(sessionId);
    if (!state) return null;
    const status = statusOf(state);
    const code = status === 'qr-pending' ? await currentLinkCode(sessionId) : null;
    // A session whose Telegram account is known waits only for the Business connection: its link
    // was spent, and what is left is said by the panel, not by a code.
    return { status, qr: code ? await linkFor(code) : null };
  },

  async session(sessionId) {
    const state = await readBusinessSession(sessionId);
    return state ? sessionReport(state) : null;
  },

  // The bot cannot end a Business connection; the person removes it in Telegram. Forgetting the
  // session here stops everything on this side, and its chats and messages go with it.
  remove: deleteBusinessSession,

  async chats(sessionId, limit) {
    const chats = await listBusinessChats(sessionId, limit);
    return chats.map((chat) => ({
      chatId: chat.chatId,
      name: chat.name,
      kind: 'direct' as const,
      unreadCount: chat.unreadCount,
      lastMessageAt: chat.lastMessageAt,
      lastMessagePreview: chat.lastMessagePreview,
    }));
  },

  async messages(sessionId, chatId, limit) {
    const messages = await listBusinessMessages(sessionId, chatId, limit);
    return messages.map((message) => ({
      id: message.messageId,
      fromMe: message.fromMe,
      sender: message.senderName,
      text: message.text,
      at: message.at,
    }));
  },

  async send(sessionId, chatId, text) {
    const state = await readBusinessSession(sessionId);
    const connection = state?.connection;
    if (!state || !connection || statusOf(state) !== 'connected') return null;
    if (!connection.canReply) {
      throw new Error(
        'Telegram does not let the gemie write from this account: allow "Reply to messages" for the bot in Telegram › Settings › Telegram Business › Chatbots.',
      );
    }
    const chat = await findBusinessChat(sessionId, chatId);
    const now = Math.floor(Date.now() / 1000);
    if (!chat?.lastIncomingAt || now - chat.lastIncomingAt > REPLY_WINDOW_SECONDS) {
      throw new Error(
        'Telegram only lets the gemie write in private chats where the contact wrote in the last 24 hours.',
      );
    }
    try {
      const messageId = await sendAsAccount({
        sessionId,
        connection,
        chatId,
        chatName: chat.name,
        text,
      });
      return { messageId };
    } catch (error: unknown) {
      if (error instanceof TelegramApiError) throw new Error(error.description);
      throw error;
    }
  },

  async notify(sessionId, text) {
    const state = await readBusinessSession(sessionId);
    if (!state?.telegramUserId) return null;
    // The person's own chat with the shared bot, which they opened from the panel's link.
    const messageId = await sendText(bot(), { chatId: state.telegramUserId }, text);
    return { messageId };
  },
};
