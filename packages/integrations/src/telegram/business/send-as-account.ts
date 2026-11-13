import { sharedBot } from '../bots';
import { sendText } from '../send';
import { recordBusinessMessage, type BusinessConnectionRow } from './repository';

/**
 * Write in one of a Telegram Business account's private chats, as the account, and keep what was
 * written with the chat, so the gemie reads back its own words beside the contact's.
 */
export async function sendAsAccount(input: {
  sessionId: string;
  connection: BusinessConnectionRow;
  chatId: string;
  chatName: string;
  text: string;
}): Promise<string> {
  const api = sharedBot();
  if (!api) throw new Error('The shared Telegram bot is not configured');
  const messageId = await sendText(
    api,
    { chatId: input.chatId, businessConnectionId: input.connection.connectionId },
    input.text,
  );
  await recordBusinessMessage({
    sessionId: input.sessionId,
    chatId: input.chatId,
    chatName: input.chatName,
    messageId,
    fromMe: true,
    senderName: input.connection.displayName,
    text: input.text,
    at: Math.floor(Date.now() / 1000),
  });
  return messageId;
}
