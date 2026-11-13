/**
 * What the shared Gemies bot does with the updates Telegram sends it (ADR 0037):
 *
 *  - in its own chat, `/start <code>` from a panel's link tells it which Telegram account is the
 *    person's; anything else gets a short note on how to link it;
 *  - `business_connection` is the person connecting, editing, turning off or turning back on the
 *    bot in Telegram › Settings › Telegram Business › Chatbots. It is stored as Telegram reports
 *    it and never expires here;
 *  - `business_message`, `edited_business_message` and `deleted_business_messages` are the
 *    account's private chats: stored (so the gemies granted it can read them later), and a
 *    contact's message is answered by the account's answering gemie when the person chose one, the
 *    account's replies say so and Telegram lets it (the API decides: `POST /channel-accounts/inbound`).
 *
 * Every change of a session's status is told to the API right away, so the gemies' tools and the
 * panel follow Telegram without anybody opening Gemies.
 */

import { APIClient } from '../../shared/api-client';
import { handleIncomingMessage } from '../../shared/chat-handler';
import { createLogger } from '../../shared/logger';
import type { BotApi } from '../bot-api';
import { sendText, whileTyping } from '../send';
import type {
  TelegramBusinessConnection,
  TelegramBusinessMessagesDeleted,
  TelegramMessage,
  TelegramUpdate,
} from '../types';
import {
  claimLinkCode,
  deleteBusinessMessages,
  editBusinessMessage,
  findBusinessConnection,
  findSessionOfTelegramUser,
  readBusinessSession,
  recordBusinessMessage,
  nameOf,
  saveBusinessConnection,
  sessionReport,
  statusOf,
} from './repository';
import { sendAsAccount } from './send-as-account';

const logger = createLogger('telegram/business');
export const apiClient = new APIClient('telegram');

/** Tell the API a session moved. Best effort: the panel also asks for it live. */
async function report(sessionId: string): Promise<void> {
  const state = await readBusinessSession(sessionId);
  if (!state) return;
  try {
    await apiClient.reportAccountSession(sessionId, sessionReport(state));
  } catch (error: unknown) {
    logger.warn(`Could not tell the API that session ${sessionId} moved:`, error);
  }
}

/** The few things the bot says in its own chat, in the person's language when it has it. */
const COPY = {
  en: {
    linked: (bot: string) =>
      `Linked. Now open Telegram › Settings › Telegram Business › Chatbots, add @${bot} and choose the chats it may answer. Telegram Business needs Telegram Premium and covers private chats only.`,
    connected:
      'Linked and connected. In Settings › Connected accounts, choose which of your gemies may use it and which one answers.',
    expired:
      'This link has expired or was already used. Open it again from Settings › Connected accounts.',
    howTo:
      'I connect your Telegram to your gemies. In Gemies or Alia, open Settings › Connected accounts › Telegram and follow the link from there.',
    unlinked:
      'Telegram Business is connected, but not to your gemies yet. In Gemies or Alia, open Settings › Connected accounts › Telegram and follow the link from there.',
  },
  es: {
    linked: (bot: string) =>
      `Vinculado. Ahora abre Telegram › Ajustes › Telegram Business › Chatbots, añade a @${bot} y elige los chats que puede responder. Telegram Business necesita Telegram Premium y solo cubre chats privados.`,
    connected:
      'Vinculado y conectado. En Ajustes › Cuentas conectadas, elige qué gemies pueden usarlo y cuál responde.',
    expired:
      'Este enlace ha caducado o ya se usó. Ábrelo de nuevo desde Ajustes › Cuentas conectadas.',
    howTo:
      'Conecto tu Telegram con tus gemies. En Gemies o en Alia, abre Ajustes › Cuentas conectadas › Telegram y sigue el enlace desde ahí.',
    unlinked:
      'Telegram Business está conectado, pero aún no a tus gemies. En Gemies o en Alia, abre Ajustes › Cuentas conectadas › Telegram y sigue el enlace desde ahí.',
  },
};
function copyFor(user: { language_code?: string } | undefined) {
  return user?.language_code?.startsWith('es') ? COPY.es : COPY.en;
}

/** The shared bot's own chat: linking a Telegram account to a session. */
async function onOwnChatMessage(api: BotApi, username: string, message: TelegramMessage) {
  const from = message.from;
  if (!from || from.is_bot || message.chat.type !== 'private') return;
  const copy = copyFor(from);
  const reply = (text: string) => sendText(api, { chatId: String(message.chat.id) }, text);
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(message.text ?? '');
  const code = start?.[1];
  if (!code) return reply(copy.howTo);

  const claimed = await claimLinkCode(code, String(from.id));
  if (!claimed) return reply(copy.expired);
  await Promise.all([claimed.sessionId, ...claimed.released].map(report));
  const state = await readBusinessSession(claimed.sessionId);
  await reply(state && statusOf(state) === 'connected' ? copy.connected : copy.linked(username));
}

async function onConnection(api: BotApi, connection: TelegramBusinessConnection) {
  const telegramUserId = String(connection.user.id);
  const rights = Object.fromEntries(
    Object.entries(connection.rights ?? {}).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  );
  const { isNew } = await saveBusinessConnection({
    telegramUserId,
    connectionId: connection.id,
    userChatId: String(connection.user_chat_id),
    username: connection.user.username ?? null,
    displayName: nameOf(connection.user),
    isEnabled: connection.is_enabled,
    rights,
  });
  const session = await findSessionOfTelegramUser(telegramUserId);
  if (session) {
    await report(session.sessionId);
    return;
  }
  // Connected in Telegram before the panel's link was opened: say how to finish, once.
  if (isNew && connection.is_enabled) {
    await sendText(
      api,
      { chatId: String(connection.user_chat_id) },
      copyFor(connection.user).unlinked,
    ).catch((error: unknown) =>
      logger.warn('Could not tell a person how to finish linking:', error),
    );
  }
}

/** The session and connection a business update belongs to, when it belongs to a linked one. */
async function sessionOfConnection(connectionId: string | undefined) {
  if (!connectionId) return null;
  const connection = await findBusinessConnection(connectionId);
  if (!connection) return null;
  const session = await findSessionOfTelegramUser(connection.telegramUserId);
  return session ? { session, connection } : null;
}

async function onBusinessMessage(api: BotApi, message: TelegramMessage) {
  const found = await sessionOfConnection(message.business_connection_id);
  if (!found || message.chat.type !== 'private') return;
  const { session, connection } = found;
  const text = message.text ?? message.caption ?? '';
  // The account's own messages: the person, from their phone, or the gemie on their behalf.
  const fromMe =
    Boolean(message.sender_business_bot) || String(message.from?.id) === connection.telegramUserId;
  const chatId = String(message.chat.id);
  const chatName = nameOf(message.chat);
  await recordBusinessMessage({
    sessionId: session.sessionId,
    chatId,
    chatName,
    messageId: String(message.message_id),
    fromMe,
    senderName: message.from ? nameOf(message.from) : null,
    text,
    at: message.date,
  });
  if (fromMe || !text || message.from?.is_bot) return;
  if (!connection.isEnabled || !connection.canReply) return;

  const target = { chatId, businessConnectionId: connection.connectionId };
  await whileTyping(api, target, () =>
    handleIncomingMessage(
      {
        platform: 'telegram',
        sessionId: session.sessionId,
        inbound: { chatId, chatKind: 'direct', mentionsAccount: false },
        messageText: text,
        sendResponse: async (reply) => {
          await sendAsAccount({
            sessionId: session.sessionId,
            connection,
            chatId,
            chatName,
            text: reply,
          });
        },
        charLimit: 3500,
        platformContext:
          'You are answering in the person’s own Telegram private chat with one of their contacts, on their behalf.',
      },
      apiClient,
    ),
  );
}

async function onEditedBusinessMessage(message: TelegramMessage) {
  const found = await sessionOfConnection(message.business_connection_id);
  if (!found) return;
  await editBusinessMessage({
    sessionId: found.session.sessionId,
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    text: message.text ?? message.caption ?? '',
  });
}

async function onDeletedBusinessMessages(deleted: TelegramBusinessMessagesDeleted) {
  const found = await sessionOfConnection(deleted.business_connection_id);
  if (!found) return;
  await deleteBusinessMessages({
    sessionId: found.session.sessionId,
    chatId: String(deleted.chat.id),
    messageIds: deleted.message_ids.map(String),
  });
}

/** Handle one update of the shared bot. */
export async function handleSharedBotUpdate(
  api: BotApi,
  username: string,
  update: TelegramUpdate,
): Promise<void> {
  if (update.message) return void (await onOwnChatMessage(api, username, update.message));
  if (update.business_connection) return onConnection(api, update.business_connection);
  if (update.business_message) return onBusinessMessage(api, update.business_message);
  if (update.edited_business_message) {
    return onEditedBusinessMessage(update.edited_business_message);
  }
  if (update.deleted_business_messages) {
    return onDeletedBusinessMessages(update.deleted_business_messages);
  }
}
