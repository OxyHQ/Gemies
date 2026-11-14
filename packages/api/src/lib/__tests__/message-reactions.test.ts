import { describe, expect, it } from 'vitest';
import {
  MAX_REACTIONS_PER_MESSAGE,
  parseHeldReaction,
  parseReaction,
  toggleReaction,
} from '../../domain/message-reactions.js';

describe('parseReaction', () => {
  it.each(['👍', '❤️', '🇪🇸', '👍🏽', '👨‍👩‍👧', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🧑🏽‍💻'])('accepts %s', (emoji) => {
    expect(parseReaction(emoji)).toBe(emoji);
  });

  it.each([
    ['hello'],
    [''],
    ['   '],
    ['👍 hi'],
    [42],
    [null],
    ['👍'.repeat(20)],
    // Two emoji are two reactions, never one.
    ['👍🎉'],
    ['🇪🇸🇫🇷'],
    // A joiner, a tone or a selector is not an emoji on its own.
    ['\u200d'],
    ['\u{1F3FD}'],
    ['\ufe0f'],
  ])('refuses %s', (value) => {
    expect(parseReaction(value)).toBeNull();
  });

  it('trims the surrounding space', () => {
    expect(parseReaction(' 🎉 ')).toBe('🎉');
  });
});

describe('parseHeldReaction', () => {
  it('takes back one stored before a reaction had to be one emoji, and any single one', () => {
    expect(parseHeldReaction('👍🎉')).toBe('👍🎉');
    expect(parseHeldReaction('👍')).toBe('👍');
  });

  it.each([['hello'], [''], ['👍 hi'], [42], ['👍'.repeat(20)]])('refuses %s', (value) => {
    expect(parseHeldReaction(value)).toBeNull();
  });
});

describe('toggleReaction', () => {
  it('adds a reaction, and takes it back on the second tap', () => {
    expect(toggleReaction([], '👍')).toEqual(['👍']);
    expect(toggleReaction(['👍'], '👍')).toEqual([]);
  });

  it('keeps the others when one is taken back', () => {
    expect(toggleReaction(['👍', '🎉'], '👍')).toEqual(['🎉']);
  });

  it('changes nothing once the message holds the most it takes', () => {
    const full = ['😀', '😂', '😍', '🎉', '🔥', '👍'];
    expect(full).toHaveLength(MAX_REACTIONS_PER_MESSAGE);
    expect(toggleReaction(full, '👎')).toEqual(full);
    expect(toggleReaction(full, '🔥')).toEqual(['😀', '😂', '😍', '🎉', '👍']);
  });
});
