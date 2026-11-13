import { getDb } from '../../db';
import type { AccountGateway } from '../gateway';
import {
  findLatestWhatsAppMessageText,
  findWhatsAppSession,
  findWhatsAppSessionOwner,
  findWhatsAppSessionQr,
  listWhatsAppChats,
  listWhatsAppMessages,
} from './repository';
import { sessionManager } from './session-manager';

/** WhatsApp Web (Baileys), linked by scanning a code in WhatsApp › Linked devices. */
export const whatsAppGateway: AccountGateway = {
  platform: 'whatsapp',

  initialize: () => sessionManager.initialize(),
  shutdown: () => sessionManager.shutdown(),
  ownerOf: (sessionId) => findWhatsAppSessionOwner(getDb(), sessionId),

  async link(oxyUserId) {
    const { sessionId, qrPromise } = await sessionManager.createSession(oxyUserId);
    return { sessionId, qr: await qrPromise };
  },

  async qr(sessionId) {
    const session = await findWhatsAppSessionQr(getDb(), sessionId);
    if (!session) return null;
    return {
      status: session.status,
      qr: session.status === 'qr-pending' ? (session.lastQr ?? null) : null,
    };
  },

  async session(sessionId) {
    const session = await findWhatsAppSession(getDb(), sessionId);
    if (!session) return null;
    return {
      status: session.status,
      phoneNumber: session.phoneNumber,
      displayName: session.displayName,
    };
  },

  remove: (sessionId) => sessionManager.removeSession(sessionId),

  async chats(sessionId, limit) {
    const chats = await listWhatsAppChats(getDb(), sessionId, limit);
    return Promise.all(
      chats.map(async (chat) => ({
        chatId: chat.jid,
        name: chat.name || chat.jid.split('@')[0] || chat.jid,
        kind: chat.jid.endsWith('@g.us') ? ('group' as const) : ('direct' as const),
        unreadCount: chat.unreadCount || 0,
        lastMessageAt: chat.conversationTimestamp ?? null,
        lastMessagePreview:
          (await findLatestWhatsAppMessageText(getDb(), sessionId, chat.jid))?.slice(0, 100) ?? '',
      })),
    );
  },

  async messages(sessionId, chatId, limit) {
    const messages = await listWhatsAppMessages(getDb(), sessionId, chatId, limit);
    return messages.map((message) => ({
      id: message.messageId,
      fromMe: message.fromMe,
      sender: message.pushName ?? null,
      text: message.text ?? '',
      at: message.timestamp,
    }));
  },

  async send(sessionId, chatId, text) {
    const sock = sessionManager.getSocket(sessionId);
    if (!sock) return null;
    const result = await sock.sendMessage(chatId, { text });
    return { messageId: result?.key?.id ?? '' };
  },
};
