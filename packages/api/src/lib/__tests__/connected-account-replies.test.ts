/**
 * Who a gemie answers on a connected account (ADR 0035): `shouldAnswer`, the one rule the gateway
 * asks through `POST /channel-accounts/inbound` before a message reaches a turn.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { channels: child } };
});

const { shouldAnswer } = await import('../connected-accounts.js');

const direct = { chatId: 'ana', chatKind: 'direct', mentionsAccount: false } as const;
const group = { chatId: 'family', chatKind: 'group', mentionsAccount: false } as const;
const mentioned = { ...group, mentionsAccount: true } as const;

const account = (over: Partial<Parameters<typeof shouldAnswer>[0]> = {}) => ({
  replies: 'everyone' as const,
  replyChatIds: [] as string[],
  groupReplies: 'mentions' as const,
  ...over,
});

describe('who the gemie answers', () => {
  it('answers every direct chat by default, and a group only when it is mentioned', () => {
    expect(shouldAnswer(account(), direct)).toBe(true);
    expect(shouldAnswer(account(), group)).toBe(false);
    expect(shouldAnswer(account(), mentioned)).toBe(true);
  });

  it('never answers a group the person closed', () => {
    expect(shouldAnswer(account({ groupReplies: 'never' }), mentioned)).toBe(false);
    expect(shouldAnswer(account({ groupReplies: 'never' }), direct)).toBe(true);
  });

  it('answers only the chats the person chose', () => {
    const chosen = account({ replies: 'chosen', replyChatIds: ['ana', 'family'] });
    expect(shouldAnswer(chosen, direct)).toBe(true);
    expect(shouldAnswer(chosen, { ...direct, chatId: 'stranger' })).toBe(false);
    expect(shouldAnswer(chosen, mentioned)).toBe(true);
    expect(shouldAnswer(chosen, group)).toBe(false);
  });

  it('answers nobody when told so, mentioned or not', () => {
    const nobody = account({ replies: 'nobody' });
    for (const inbound of [direct, group, mentioned])
      expect(shouldAnswer(nobody, inbound)).toBe(false);
  });
});
