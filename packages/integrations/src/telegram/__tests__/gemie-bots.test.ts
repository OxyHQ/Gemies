/**
 * A gemie's own Telegram bot (ADR 0037): what is the gemie's to answer, what it reads, and that
 * only Telegram's own deliveries reach the inbox.
 */

import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const asked = vi.hoisted(() => ({
  messages: [] as unknown[],
  reply: 'Hello from the gemie',
  personTurn: null as null | { conversationId: string },
  chats: [] as Array<{ identity: unknown; messages: unknown[]; conversationId?: string }>,
}));
vi.mock('../../shared/api-client', () => ({
  APIClient: class {
    async answerTelegramBotMessage(_botId: string, message: unknown) {
      asked.messages.push(message);
      return asked.personTurn
        ? { reply: null, personTurn: asked.personTurn }
        : { reply: asked.reply };
    }
    async getConversation() {
      return {
        messages: [
          { role: 'user', content: 'Hey' },
          { role: 'assistant', content: 'Hey Nate' },
        ],
      };
    }
    async requestModel() {
      return undefined;
    }
    async chatCompletion(
      identity: unknown,
      messages: unknown[],
      options: { conversationId?: string },
    ) {
      asked.chats.push({ identity, messages, conversationId: options.conversationId });
      return { content: 'Tienes 3 correos nuevos.', finishReason: 'stop' };
    }
  },
}));
const inbox = vi.hoisted(() => ({ accepted: [] as Array<[string, number]> }));
vi.mock('../inbox', () => ({
  acceptUpdate: vi.fn(async (botId: string, update: { update_id: number }) => {
    inbox.accepted.push([botId, update.update_id]);
    return true;
  }),
  processUpdate: vi.fn(async () => {}),
}));

import { BotApi } from '../bot-api';
import { handleGemieBotUpdate, mentionsBot, textForGemie } from '../gemie-bots';
import type { TelegramMessage } from '../types';
import { updatesRouter, webhookSecret } from '../webhook';

const BOT_ID = '8000000002';
const bot = { id: BOT_ID, username: 'eusebio_bot' };
const sends: Array<Record<string, unknown>> = [];

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop();
    if (method === 'sendMessage') sends.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true }),
    );
  });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  asked.messages.length = 0;
  sends.length = 0;
  inbox.accepted.length = 0;
});

const message = (over: Partial<TelegramMessage>): TelegramMessage => ({
  message_id: 10,
  date: 1,
  chat: { id: -100, type: 'supergroup', title: 'Team' },
  from: { id: 42, is_bot: false, first_name: 'Ana', username: 'ana' },
  text: 'hello',
  ...over,
});

describe('whether a message is addressed to the bot', () => {
  it('is a mention, a command naming it, a text mention or a reply to it', () => {
    expect(
      mentionsBot(
        message({
          text: 'hi @Eusebio_bot',
          entities: [{ type: 'mention', offset: 3, length: 12 }],
        }),
        bot,
      ),
    ).toBe(true);
    expect(
      mentionsBot(
        message({
          text: '/ask@eusebio_bot hi',
          entities: [{ type: 'bot_command', offset: 0, length: 16 }],
        }),
        bot,
      ),
    ).toBe(true);
    expect(
      mentionsBot(
        message({
          text: 'hey',
          entities: [
            {
              type: 'text_mention',
              offset: 0,
              length: 3,
              user: { id: Number(BOT_ID), is_bot: true, first_name: 'E' },
            },
          ],
        }),
        bot,
      ),
    ).toBe(true);
    expect(
      mentionsBot(
        message({
          reply_to_message: message({
            from: { id: Number(BOT_ID), is_bot: true, first_name: 'E' },
          }),
        }),
        bot,
      ),
    ).toBe(true);
    expect(
      mentionsBot(
        message({
          text: 'hi @someone_else',
          entities: [{ type: 'mention', offset: 3, length: 13 }],
        }),
        bot,
      ),
    ).toBe(false);
  });

  it('reads the text without the bot’s handle or a command naming it', () => {
    expect(textForGemie('@eusebio_bot what time is it?', 'eusebio_bot')).toBe('what time is it?');
    expect(textForGemie('/ask@eusebio_bot what time?', 'eusebio_bot')).toBe('what time?');
    expect(textForGemie('/start', 'eusebio_bot')).toBe('/start');
  });
});

describe('a gemie bot’s update', () => {
  const gemieBot = { api: new BotApi(`${BOT_ID}:${'B'.repeat(35)}`), username: 'eusebio_bot' };

  it('answers a private chat, and a group only when addressed, replying in its thread', async () => {
    await handleGemieBotUpdate(gemieBot, {
      update_id: 1,
      message: message({ chat: { id: 42, type: 'private' }, text: 'hi' }),
    });
    expect(asked.messages).toEqual([expect.objectContaining({ chatKind: 'direct', text: 'hi' })]);
    expect(sends.at(-1)).toMatchObject({ chat_id: '42' });

    await handleGemieBotUpdate(gemieBot, { update_id: 2, message: message({ text: 'chatting' }) });
    expect(asked.messages).toHaveLength(1);

    await handleGemieBotUpdate(gemieBot, {
      update_id: 3,
      message: message({
        text: '@eusebio_bot summary?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      }),
    });
    expect(asked.messages.at(-1)).toMatchObject({
      chatKind: 'group',
      chatTitle: 'Team',
      text: 'summary?',
      mentionsBot: true,
    });
    expect(sends.at(-1)).toMatchObject({
      chat_id: '-100',
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
    });
  });

  it('runs its person’s turn through the chat route as them, in its conversation (ADR 0037)', async () => {
    asked.personTurn = { conversationId: `telegram:${BOT_ID}:570038640` };
    asked.chats.length = 0;
    try {
      await handleGemieBotUpdate(gemieBot, {
        update_id: 5,
        message: message({
          chat: { id: 570038640, type: 'private' },
          from: { id: 570038640, is_bot: false, first_name: 'Nate', language_code: 'es' },
          text: '¿Qué hay en mi email?',
        }),
      });
      expect(asked.messages.at(-1)).toMatchObject({
        from: { id: '570038640', languageCode: 'es' },
      });
      expect(asked.chats).toEqual([
        {
          // The API verifies it again from the bot and the sender, never from anything else.
          identity: { kind: 'gemie_bot', botId: BOT_ID, platformUserId: '570038640' },
          conversationId: `telegram:${BOT_ID}:570038640`,
          messages: [
            expect.objectContaining({ role: 'system' }),
            { role: 'user', content: 'Hey' },
            { role: 'assistant', content: 'Hey Nate' },
            { role: 'user', content: '¿Qué hay en mi email?' },
          ],
        },
      ]);
      expect(sends.at(-1)).toMatchObject({ chat_id: '570038640' });
      expect(String(sends.at(-1)?.text)).toContain('Tienes 3 correos nuevos.');
    } finally {
      asked.personTurn = null;
    }
  });

  it('says nothing when the gemie does not answer', async () => {
    asked.reply = '';
    await handleGemieBotUpdate(gemieBot, {
      update_id: 4,
      message: message({ chat: { id: 42, type: 'private' }, text: 'hi' }),
    });
    expect(sends).toEqual([]);
    asked.reply = 'Hello from the gemie';
  });
});

describe('the webhook', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/telegram/updates',
      updatesRouter({ isOurBot: async (id) => id === BOT_ID, handle: async () => {} }),
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (botId: string, secret: string | null) =>
    fetch(`${base}/telegram/updates/${botId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
      },
      body: JSON.stringify({ update_id: 7 }),
    });

  it('accepts only Telegram’s delivery for that bot', async () => {
    vi.unstubAllGlobals();
    try {
      expect((await post(BOT_ID, null)).status).toBe(401);
      expect((await post(BOT_ID, webhookSecret('9000000003'))).status).toBe(401);
      expect((await post(BOT_ID, webhookSecret(BOT_ID))).status).toBe(200);
      expect(inbox.accepted).toEqual([[BOT_ID, 7]]);
      // A bot that is no longer ours is acknowledged and dropped.
      expect((await post('9000000003', webhookSecret('9000000003'))).status).toBe(200);
      expect(inbox.accepted).toHaveLength(1);
    } finally {
      vi.stubGlobal('fetch', async () => new Response('{"ok":true,"result":true}'));
    }
  });
});
