import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEMIE_CHAIN_BOUNDS,
  gemieChainBounds,
  gemieMessageIdOf,
  gemieReplyIdOf,
  mayWriteAgain,
} from '../policy.js';
import { isAgentWrittenMessageId } from '../../../../domain/conversation.js';

describe('the chain bounds in force', () => {
  it('are the defaults, or a positive integer set in the environment', () => {
    expect(gemieChainBounds({})).toEqual(DEFAULT_GEMIE_CHAIN_BOUNDS);
    expect(
      gemieChainBounds({ GEMIE_CHAIN_MAX_MESSAGES: '4', GEMIE_CHAIN_MAX_TOKENS: '5000' }),
    ).toEqual({ maxMessages: 4, maxTokens: 5000 });
  });

  it('never read a value that is not a positive integer as unbounded', () => {
    for (const value of ['0', '-3', '2.5', 'many', '']) {
      expect(
        gemieChainBounds({ GEMIE_CHAIN_MAX_MESSAGES: value, GEMIE_CHAIN_MAX_TOKENS: value }),
      ).toEqual(DEFAULT_GEMIE_CHAIN_BOUNDS);
    }
  });

  it('let the writer write again only when its message and the answer both fit', () => {
    const bounds = { maxMessages: 4, maxTokens: 100 };
    expect(mayWriteAgain({ messages: 2, tokens: 10 }, bounds)).toBe(true);
    expect(mayWriteAgain({ messages: 3, tokens: 10 }, bounds)).toBe(false);
    expect(mayWriteAgain({ messages: 1, tokens: 100 }, bounds)).toBe(false);
  });
});

describe('the ids a chain stores under', () => {
  it('are derived from the step, and an answer is kept by every rewrite like a room reply', () => {
    expect(gemieMessageIdOf('c', 0)).toBe('gemie-message-c-0');
    expect(gemieReplyIdOf('c', 3)).toBe('group-reply-gemies-c-3');
    expect(isAgentWrittenMessageId(gemieReplyIdOf('c', 3))).toBe(true);
  });
});
