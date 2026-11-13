/**
 * Sending a gemie's text to a Telegram chat, the one way both bots write: the model's Markdown as
 * Telegram HTML, in pieces Telegram accepts, and as plain text when Telegram refuses the HTML.
 */

import { chunkText } from '../shared/utils';
import { type BotApi, TelegramApiError } from './bot-api';
import { markdownToTelegramHtml, stripMarkdown } from './format';

/** Telegram's limit is 4096 characters; HTML tags count, so the Markdown is cut shorter. */
const CHUNK_LIMIT = 3500;

export interface SendTarget {
  chatId: string;
  /** Write as the Telegram Business account this connection belongs to. */
  businessConnectionId?: string;
  /** Thread the first piece under this message (a group reply). */
  replyToMessageId?: number;
}

/** Send `text`, and answer the id of the last message sent. */
export async function sendText(api: BotApi, target: SendTarget, text: string): Promise<string> {
  let lastId = '';
  let replyTo = target.replyToMessageId;
  for (const chunk of chunkText(text, CHUNK_LIMIT)) {
    const base = {
      chatId: target.chatId,
      businessConnectionId: target.businessConnectionId,
      replyToMessageId: replyTo,
    };
    let sent: { message_id: number };
    try {
      sent = await api.sendMessage({
        ...base,
        text: markdownToTelegramHtml(chunk),
        parseMode: 'HTML',
      });
    } catch (error: unknown) {
      // 400 "can't parse entities": the converter produced HTML Telegram will not take.
      if (
        !(
          error instanceof TelegramApiError &&
          error.code === 400 &&
          /entit/i.test(error.description)
        )
      ) {
        throw error;
      }
      sent = await api.sendMessage({ ...base, text: stripMarkdown(chunk) });
    }
    lastId = String(sent.message_id);
    replyTo = undefined;
  }
  return lastId;
}

/**
 * Show "typing…" in the chat until `work` settles: Telegram clears it after five seconds, so it is
 * repeated. Best effort; a chat that refuses it still gets the answer.
 */
export async function whileTyping<T>(
  api: BotApi,
  target: Pick<SendTarget, 'chatId' | 'businessConnectionId'>,
  work: () => Promise<T>,
): Promise<T> {
  const ping = () => {
    api.sendTyping(target.chatId, target.businessConnectionId).catch(() => {});
  };
  ping();
  const timer = setInterval(ping, 4_500);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
