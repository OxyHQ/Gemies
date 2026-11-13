/**
 * Telegram Business through the shared bot (ADR 0037), against a real Postgres, with only Telegram
 * (its HTTPS Bot API) and the Gemies API faked: linking in either order, a connection Telegram
 * turns off and on again with nothing to do in Gemies, what the gemie may read and write, and a
 * delivered update kept until it is handled.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  reports: [] as Array<{ sessionId: string; status: string; canReply?: boolean | null }>,
  answer: true,
  reply: 'Hi back' as string,
}));

vi.mock('../../shared/api-client', () => ({
  APIClient: class {
    async reportAccountSession(sessionId: string, session: { status: string; canReply?: boolean }) {
      api.reports.push({ sessionId, status: session.status, canReply: session.canReply });
    }
    async decideInbound() {
      return { answer: api.answer };
    }
    async prepareAccountMessage(_identity: unknown, incoming: { message: { text: string } }) {
      return { content: [{ type: 'text', text: incoming.message.text }] };
    }
    async getConversation() {
      return null;
    }
    async requestModel() {
      return undefined;
    }
    async chatCompletion() {
      return { content: api.reply, finishReason: 'stop' };
    }
  },
}));

const BOT_TOKEN = `7000000001:${'A'.repeat(35)}`;
const OWNER = 'person-1';
const TG_USER = 555;
const CONTACT = 777;

/** Telegram's Bot API, as far as these tests need it: every call recorded. */
const telegram = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; body: Record<string, unknown> }>,
  nextMessageId: 1000,
}));

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop() ?? '';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    telegram.calls.push({ method, body });
    const result =
      method === 'getMe'
        ? { id: 7000000001, is_bot: true, first_name: 'Gemies', username: 'gemies_bot' }
        : method === 'sendMessage'
          ? { message_id: telegram.nextMessageId++, date: 0, chat: { id: body.chat_id } }
          : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });
});

import { closePostgres, connectPostgres } from '../../db';
import { telegramBusinessGateway as gateway } from '../business/gateway';
import { handleSharedBotUpdate } from '../business/handle';
import { BotApi } from '../bot-api';
import { acceptUpdate, processUpdate } from '../inbox';
import type { TelegramUpdate } from '../types';

let updateId = 1;
const shared = () => new BotApi(BOT_TOKEN);
const deliver = (update: Omit<TelegramUpdate, 'update_id'>) =>
  handleSharedBotUpdate(shared(), 'gemies_bot', { update_id: updateId++, ...update });

const user = (id: number, first: string) => ({ id, is_bot: false, first_name: first });
const connection = (isEnabled: boolean, canReply = true) => ({
  business_connection: {
    id: `bc-${TG_USER}`,
    user: { ...user(TG_USER, 'Ada'), username: 'ada' },
    user_chat_id: TG_USER,
    date: 1,
    rights: { can_reply: canReply },
    is_enabled: isEnabled,
  },
});
const start = (code: string, from = TG_USER) => ({
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: from, type: 'private' as const },
    from: user(from, 'Ada'),
    text: `/start ${code}`,
  },
});
const contactWrites = (text: string, at = Math.floor(Date.now() / 1000)) => ({
  business_message: {
    message_id: updateId,
    date: at,
    business_connection_id: `bc-${TG_USER}`,
    chat: { id: CONTACT, type: 'private' as const, first_name: 'Bob' },
    from: user(CONTACT, 'Bob'),
    text,
  },
});
const codeOf = (link: string) => new URL(link).searchParams.get('start') ?? '';
const sent = (method = 'sendMessage') => telegram.calls.filter((call) => call.method === method);

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  connectPostgres(url);
});
afterAll(async () => {
  await closePostgres();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  telegram.calls.length = 0;
  api.reports.length = 0;
  api.answer = true;
});

describe('linking Telegram Business to a gemie', () => {
  it('links in either order, and stays connected until Telegram says otherwise', async () => {
    const { sessionId, qr } = await gateway.link(OWNER);
    expect(qr).toMatch(/^https:\/\/t\.me\/gemies_bot\?start=[A-Za-z0-9_-]{32}$/);
    expect(await gateway.session(sessionId)).toMatchObject({ status: 'qr-pending' });

    // Business connected first: kept, and the person is told how to finish.
    await deliver(connection(true));
    expect(sent().at(-1)?.body).toMatchObject({ chat_id: String(TG_USER) });
    expect(await gateway.session(sessionId)).toMatchObject({ status: 'qr-pending' });

    // Then the panel's link: linked and connected at once, and the API told so.
    await deliver(start(codeOf(qr)));
    expect(await gateway.session(sessionId)).toEqual({
      status: 'connected',
      phoneNumber: null,
      displayName: '@ada',
      canReply: true,
    });
    expect(api.reports.at(-1)).toEqual({ sessionId, status: 'connected', canReply: true });
    expect(await gateway.qr(sessionId)).toEqual({ status: 'connected', qr: null });

    // A code is spent once.
    await deliver(start(codeOf(qr), 999));
    expect(String(sent().at(-1)?.body.text)).toMatch(/expired|already used/);

    // Turned off in Telegram, then on again: paused, then back, with nothing done in Gemies.
    await deliver(connection(false));
    expect(api.reports.at(-1)).toMatchObject({ sessionId, status: 'paused' });
    await deliver(connection(true));
    expect(api.reports.at(-1)).toMatchObject({ sessionId, status: 'connected' });

    // Linking the same Telegram to another gemie moves it; the first session is over.
    const other = await gateway.link(OWNER);
    await deliver(start(codeOf(other.qr)));
    expect(await gateway.session(other.sessionId)).toMatchObject({ status: 'connected' });
    expect(await gateway.session(sessionId)).toMatchObject({ status: 'logged-out' });
    expect(api.reports.map((report) => report.sessionId)).toContain(sessionId);

    // The person can be written to in their own chat with the bot.
    expect(await gateway.notify?.(other.sessionId, 'Your task is done')).toEqual({
      messageId: expect.any(String),
    });
    expect(sent().at(-1)?.body).toMatchObject({ chat_id: String(TG_USER) });
    await gateway.remove(sessionId);
    await gateway.remove(other.sessionId);
  });
});

describe('what arrives through a connected account', () => {
  it('stores it, answers a contact as the account says, and reads truthfully', async () => {
    const { sessionId, qr } = await gateway.link(OWNER);
    await deliver(start(codeOf(qr)));
    await deliver(connection(true));

    await deliver(contactWrites('Are you free tomorrow?'));
    // Answered in the contact's chat, as the account, and the answer kept beside the question.
    expect(sent().at(-1)?.body).toMatchObject({
      chat_id: String(CONTACT),
      business_connection_id: `bc-${TG_USER}`,
    });
    const messages = await gateway.messages(sessionId, String(CONTACT), 10);
    expect(messages.map((message) => [message.fromMe, message.text])).toEqual([
      [false, 'Are you free tomorrow?'],
      [true, 'Hi back'],
    ]);
    expect(await gateway.chats(sessionId, 10)).toEqual([
      expect.objectContaining({ chatId: String(CONTACT), name: 'Bob', kind: 'direct' }),
    ]);

    // Who the gemie answers is the account's: told not to, it stays quiet.
    api.answer = false;
    telegram.calls.length = 0;
    await deliver(contactWrites('ok'));
    expect(sent()).toEqual([]);

    // Telegram withdrew "reply": it reads, it does not write.
    await deliver(connection(true, false));
    await expect(gateway.send(sessionId, String(CONTACT), 'hello')).rejects.toThrow(
      /does not let the gemie write/,
    );
    await deliver(connection(true, true));
    expect(
      (await gateway.send(sessionId, String(CONTACT), 'See you then'))?.messageId,
    ).toBeTruthy();

    // Telegram lets a business bot write only where the contact wrote in the last 24 hours.
    await expect(gateway.send(sessionId, '424242', 'hello')).rejects.toThrow(/last 24 hours/);

    // A message deleted in Telegram is forgotten here too.
    const [first] = await gateway.messages(sessionId, String(CONTACT), 10);
    await deliver({
      deleted_business_messages: {
        business_connection_id: `bc-${TG_USER}`,
        chat: { id: CONTACT, type: 'private' },
        message_ids: [Number(first?.id)],
      },
    });
    expect((await gateway.messages(sessionId, String(CONTACT), 10)).map((m) => m.id)).not.toContain(
      first?.id,
    );

    // Paused in Telegram: nothing is sent from it.
    await deliver(connection(false));
    expect(await gateway.send(sessionId, String(CONTACT), 'hi')).toBeNull();
    await gateway.remove(sessionId);
  });
});

describe('a delivered update', () => {
  it('is kept once, handled once, and not handled again', async () => {
    const handle = vi.fn(async () => {});
    const update = { update_id: 900001, message: undefined };
    expect(await acceptUpdate('7000000001', update)).toBe(true);
    // Telegram delivering it again is recognised.
    expect(await acceptUpdate('7000000001', update)).toBe(false);
    await processUpdate('7000000001', 900001, handle);
    await processUpdate('7000000001', 900001, handle);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('is left for the sweep when handling it fails', async () => {
    let attempts = 0;
    const handle = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the API is restarting');
    };
    const update = { update_id: 900002 };
    await acceptUpdate('7000000001', update);
    await processUpdate('7000000001', 900002, handle);
    await processUpdate('7000000001', 900002, handle);
    expect(attempts).toBe(2);
  });
});
