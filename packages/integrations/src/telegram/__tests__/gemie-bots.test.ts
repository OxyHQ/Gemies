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
  reaction: null as string | null,
  personTurn: null as null | { conversationId: string; messageId: string; content: unknown[] },
  chats: [] as Array<{ identity: unknown; messages: unknown[]; conversationId?: string }>,
}));
vi.mock('../../shared/api-client', () => ({
  APIClient: class {
    async answerTelegramBotMessage(_botId: string, message: unknown) {
      asked.messages.push(message);
      return asked.personTurn
        ? { reply: null, personTurn: asked.personTurn }
        : { reply: asked.reply, reaction: asked.reaction };
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
/** Every other Bot API call, by method. */
const calls: Array<[string, Record<string, unknown>]> = [];
/** What `getFile` + the file download serve, by file id. */
const files = new Map<string, Buffer>([
  ['sticker-1', Buffer.from('RIFF0000WEBPVP8 sticker')],
  ['photo-big', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])],
  ['voice-1', Buffer.from('OggS voice')],
]);

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/file/bot')) {
      const bytes = files.get(path.split('/').pop() ?? '');
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
    }
    const method = path.split('/').pop() ?? '';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === 'sendMessage') sends.push(body);
    else calls.push([method, body]);
    const result =
      method === 'sendMessage' || method === 'sendPhoto'
        ? { message_id: 1 }
        : method === 'getFile'
          ? { file_id: body.file_id, file_unique_id: 'u', file_path: body.file_id }
          : true;
    return new Response(JSON.stringify({ ok: true, result }));
  });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  asked.messages.length = 0;
  asked.reaction = null;
  sends.length = 0;
  calls.length = 0;
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
    expect(asked.messages).toEqual([
      expect.objectContaining({ chatKind: 'direct', message: { text: 'hi' } }),
    ]);
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
      message: { text: 'summary?' },
      mentionsBot: true,
    });
    expect(sends.at(-1)).toMatchObject({
      chat_id: '-100',
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
    });
  });

  it('runs its person’s turn through the chat route as them, in its conversation (ADR 0037)', async () => {
    // The API prepared the message (its media kept as the person's): the turn carries it as is.
    const prepared = [{ type: 'text', text: '¿Qué hay en mi email?' }];
    asked.personTurn = {
      conversationId: `telegram:${BOT_ID}:570038640`,
      messageId: 'telegram:570038640:10',
      content: prepared,
    };
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
            { id: 'telegram:570038640:10', role: 'user', content: prepared },
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

  it('reads a sticker it was sent: its image, emoji and set', async () => {
    await handleGemieBotUpdate(gemieBot, {
      update_id: 5,
      message: message({
        chat: { id: 42, type: 'private' },
        text: undefined,
        sticker: {
          file_id: 'sticker-1',
          file_unique_id: 's',
          type: 'regular',
          is_animated: false,
          is_video: false,
          emoji: '😂',
          set_name: 'HappyCats',
        },
      }),
    });
    expect(asked.messages.at(-1)).toMatchObject({
      message: {
        text: '',
        media: [
          {
            kind: 'sticker',
            emoji: '😂',
            setName: 'HappyCats',
            file: { mime: 'image/webp', data: files.get('sticker-1')?.toString('base64') },
          },
        ],
      },
    });
    expect(sends.at(-1)).toMatchObject({ chat_id: '42' });
  });

  it('reads the largest size of a photo with its caption, and a voice note', async () => {
    await handleGemieBotUpdate(gemieBot, {
      update_id: 6,
      message: message({
        chat: { id: 42, type: 'private' },
        text: undefined,
        caption: 'look',
        photo: [
          { file_id: 'photo-small', file_unique_id: 'a', width: 90, height: 90 },
          { file_id: 'photo-big', file_unique_id: 'b', width: 1280, height: 1280 },
        ],
      }),
    });
    expect(asked.messages.at(-1)).toMatchObject({
      message: { text: 'look', media: [{ kind: 'photo', file: { mime: 'image/jpeg' } }] },
    });
    await handleGemieBotUpdate(gemieBot, {
      update_id: 7,
      message: message({
        chat: { id: 42, type: 'private' },
        text: undefined,
        voice: { file_id: 'voice-1', file_unique_id: 'v', duration: 4, mime_type: 'audio/ogg' },
      }),
    });
    expect(asked.messages.at(-1)).toMatchObject({
      message: { media: [{ kind: 'voice', durationSeconds: 4, file: { mime: 'audio/ogg' } }] },
    });
  });

  it('says what it could not fetch rather than dropping it', async () => {
    await handleGemieBotUpdate(gemieBot, {
      update_id: 8,
      message: message({
        chat: { id: 42, type: 'private' },
        text: undefined,
        document: {
          file_id: 'big-doc',
          file_unique_id: 'd',
          file_name: 'film.mkv',
          file_size: 900 * 1024 * 1024,
        },
      }),
    });
    expect(asked.messages.at(-1)).toMatchObject({
      message: {
        media: [{ kind: 'document', filename: 'film.mkv', missing: 'too large to fetch' }],
      },
    });
  });

  it('stores an edit without answering it, and fetches nothing for it', async () => {
    await handleGemieBotUpdate(gemieBot, {
      update_id: 9,
      edited_message: message({ chat: { id: 42, type: 'private' }, text: 'hi, edited' }),
    });
    expect(asked.messages.at(-1)).toMatchObject({ edited: true, message: { text: 'hi, edited' } });
    expect(sends).toEqual([]);
    expect(calls.map(([method]) => method)).not.toContain('sendChatAction');
  });

  it('reacts when the gemie chose to, and sends the images its answer shows', async () => {
    asked.reaction = '👍';
    asked.reply = 'Here it is:\n\n![a cat](https://example.com/cat.png)';
    await handleGemieBotUpdate(gemieBot, {
      update_id: 10,
      message: message({ chat: { id: 42, type: 'private' }, text: 'a cat please' }),
    });
    expect(calls).toContainEqual([
      'setMessageReaction',
      { chat_id: '42', message_id: 10, reaction: [{ type: 'emoji', emoji: '👍' }] },
    ]);
    expect(sends.at(-1)).toMatchObject({ text: 'Here it is:' });
    expect(calls).toContainEqual([
      'sendPhoto',
      expect.objectContaining({
        chat_id: '42',
        photo: 'https://example.com/cat.png',
        caption: 'a cat',
      }),
    ]);
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
