/**
 * A gemie's own Telegram bot (ADR 0037): what is the gemie's to answer before anything is spent,
 * and how much one sender may ask of it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));

const { botAnswers, botConversationId, isSenderRateLimited } = await import(
  '../gemie-telegram-bot.js'
);

describe('what the gemie answers on its bot', () => {
  it('answers every private chat', () => {
    expect(botAnswers({ groupReplies: 'never' }, { chatKind: 'direct', mentionsBot: false })).toBe(
      true,
    );
  });

  it('answers a group only when addressed, and never when told so', () => {
    const mentions = { groupReplies: 'mentions' as const };
    expect(botAnswers(mentions, { chatKind: 'group', mentionsBot: true })).toBe(true);
    expect(botAnswers(mentions, { chatKind: 'group', mentionsBot: false })).toBe(false);
    expect(botAnswers({ groupReplies: 'never' }, { chatKind: 'group', mentionsBot: true })).toBe(
      false,
    );
  });

  it('keeps one conversation per chat of a bot', () => {
    expect(botConversationId({ botId: '8' }, '-100')).toBe('telegram:8:-100');
    expect(botConversationId({ botId: '8' }, '42')).not.toBe(
      botConversationId({ botId: '9' }, '42'),
    );
  });

  it('drops a sender who floods the bot, and only that sender', () => {
    const now = Date.now();
    for (let i = 0; i < 15; i += 1) expect(isSenderRateLimited('b', 'flood', now)).toBe(false);
    expect(isSenderRateLimited('b', 'flood', now)).toBe(true);
    expect(isSenderRateLimited('b', 'calm', now)).toBe(false);
    expect(isSenderRateLimited('b', 'flood', now + 61_000)).toBe(false);
  });
});
