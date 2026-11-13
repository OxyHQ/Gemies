/**
 * What a gemie posts on its own into one of its bot's conversations reaches that Telegram chat
 * (ADR 0037, amendment): a scheduled result asked on Telegram answers on Telegram.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  bot: { agentId: 'gemie-1', token: '8988966019:TOKEN' } as {
    agentId: string;
    token: string;
  } | null,
  sent: [] as Array<{ path: string; body: unknown }>,
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/integrations/gemieBotRepository.js', () => ({
  findActiveGemieBotTokenByTelegramId: vi.fn(async () => state.bot),
}));
vi.mock('../integrations-client.js', () => ({
  integrationsServiceFetch: vi.fn(async (path: string, init: RequestInit) => {
    state.sent.push({ path, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }),
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { channels: child, agents: child } };
});

const { relayToGemieBotChat } = await import('../gemie-telegram-bot-setup.js');

beforeEach(() => {
  state.sent = [];
  state.bot = { agentId: 'gemie-1', token: '8988966019:TOKEN' };
});

describe('a gemie’s message in a conversation of its bot', () => {
  it('is sent to that Telegram chat, as the bot', async () => {
    await relayToGemieBotChat({
      agentId: 'gemie-1',
      conversationId: 'telegram:8988966019:570038640',
      text: 'Mañana en Barcelona: 18 °C y sol.',
    });
    expect(state.sent).toEqual([
      {
        path: '/telegram/bots/send',
        body: {
          token: '8988966019:TOKEN',
          chatId: '570038640',
          text: 'Mañana en Barcelona: 18 °C y sol.',
        },
      },
    ]);
  });

  it('reaches a group chat of the bot too', async () => {
    await relayToGemieBotChat({
      agentId: 'gemie-1',
      conversationId: 'telegram:8988966019:-1001234',
      text: 'Hecho',
    });
    expect(state.sent[0]?.body).toMatchObject({ chatId: '-1001234' });
  });

  it('goes nowhere for any other conversation, or another gemie’s bot', async () => {
    await relayToGemieBotChat({ agentId: 'gemie-1', conversationId: 'a-uuid', text: 'x' });
    await relayToGemieBotChat({
      agentId: 'other-gemie',
      conversationId: 'telegram:8988966019:570038640',
      text: 'x',
    });
    state.bot = null;
    await relayToGemieBotChat({
      agentId: 'gemie-1',
      conversationId: 'telegram:8988966019:570038640',
      text: 'x',
    });
    expect(state.sent).toEqual([]);
  });
});
