import { getDb } from '../../db';
import type { AccountGateway } from '../gateway';
import {
  findLatestTelegramMessageText,
  findTelegramSession,
  findTelegramSessionOwner,
  findTelegramSessionQr,
  listTelegramChats,
  listTelegramMessages,
} from './repository';
import { sessionManager } from './session-manager';

/**
 * A person's own Telegram account (MTProto, GramJS), linked by scanning a code in Telegram ›
 * Devices. Needs this deployment's `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` (my.telegram.org);
 * without them it is not offered at all (`src/index.ts`).
 */
export const telegramGateway: AccountGateway = {
  platform: 'telegram',

  initialize: () => sessionManager.initialize(),
  shutdown: () => sessionManager.shutdown(),
  ownerOf: (sessionId) => findTelegramSessionOwner(getDb(), sessionId),

  async link(oxyUserId) {
    const { sessionId, qrPromise } = await sessionManager.createSession(oxyUserId);
    return { sessionId, qr: await qrPromise };
  },

  async qr(sessionId) {
    const session = await findTelegramSessionQr(getDb(), sessionId);
    if (!session) return null;
    return {
      status: session.status,
      qr: session.status === 'qr-pending' ? (session.lastQr ?? null) : null,
    };
  },

  async session(sessionId) {
    const session = await findTelegramSession(getDb(), sessionId);
    if (!session) return null;
    return {
      status: session.status,
      phoneNumber: session.phoneNumber,
      displayName: session.displayName,
    };
  },

  remove: (sessionId) => sessionManager.removeSession(sessionId),

  async chats(sessionId, limit) {
    const chats = await listTelegramChats(getDb(), sessionId, limit);
    return Promise.all(
      chats.map(async (chat) => ({
        chatId: chat.chatId,
        name: chat.name || chat.chatId,
        kind: chat.chatType === 'user' ? ('direct' as const) : ('group' as const),
        unreadCount: chat.unreadCount || 0,
        lastMessageAt: chat.lastMessageTimestamp ?? null,
        lastMessagePreview:
          (await findLatestTelegramMessageText(getDb(), sessionId, chat.chatId))?.slice(0, 100) ??
          '',
      })),
    );
  },

  async messages(sessionId, chatId, limit) {
    const messages = await listTelegramMessages(getDb(), sessionId, chatId, limit);
    return messages.map((message) => ({
      id: message.messageId,
      fromMe: message.fromMe,
      sender: message.senderName || null,
      text: message.text ?? '',
      at: message.timestamp,
    }));
  },

  async send(sessionId, chatId, text) {
    const client = sessionManager.getSocket(sessionId);
    if (!client) return null;
    const result = await client.sendMessage(chatId, { message: text });
    return { messageId: String(result?.id ?? '') };
  },
};
