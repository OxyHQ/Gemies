/**
 * Sending a gemie's answer to a Telegram chat, the one way both bots write: the model's Markdown as
 * Telegram HTML, in pieces Telegram accepts, and as plain text when Telegram refuses the HTML; an
 * image the answer shows (`![alt](https://…)`, as a tool's result is shown) as a photo.
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

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g;

/** An answer's words, and the images it shows, in order. */
export function splitImages(text: string): {
  text: string;
  images: Array<{ url: string; alt: string }>;
} {
  const images: Array<{ url: string; alt: string }> = [];
  const words = text.replace(MARKDOWN_IMAGE, (_match, alt: string, url: string) => {
    images.push({ url, alt: alt.trim() });
    return '';
  });
  return { text: words.replace(/\n{3,}/g, '\n\n').trim(), images };
}

/** Send an answer: its words, then each image it shows as a photo. Answers the last message's id. */
export async function sendReply(api: BotApi, target: SendTarget, answer: string): Promise<string> {
  const { text, images } = splitImages(answer);
  let lastId = text ? await sendText(api, target, text) : '';
  for (const image of images) {
    try {
      const sent = await api.sendPhoto({
        chatId: target.chatId,
        photo: image.url,
        caption: image.alt || undefined,
        businessConnectionId: target.businessConnectionId,
        replyToMessageId: lastId ? undefined : target.replyToMessageId,
      });
      lastId = String(sent.message_id);
    } catch (error: unknown) {
      // Telegram could not fetch it: the link still reaches the person.
      if (!(error instanceof TelegramApiError)) throw error;
      lastId = await sendText(api, { ...target, replyToMessageId: undefined }, image.url);
    }
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
