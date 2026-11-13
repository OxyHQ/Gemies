import { avatarCharacterFor } from '@oxy.so/contracts';
import { describe, expect, it } from 'vitest';
import { gemieCharacterOf, parseGemieCharacter } from '../agent-character.js';

/** A gemie's character keeps its shape and features; its colour is its account's. */
describe('a gemie character', () => {
  const parts = { shape: 'heart', eyes: 'oval', eyewear: 'none', accessory: 'bow' };

  it('is accepted without a paint, by shape or by preset', () => {
    expect(parseGemieCharacter(parts)).toEqual(parts);
    expect(parseGemieCharacter({ preset: 'blue_beret', accessory: 'none' })).toEqual({
      preset: 'blue_beret',
      accessory: 'none',
    });
  });

  it.each([
    ['a named paint', { ...parts, color: 'pink' }],
    ['a free hex', { ...parts, bodyColor: '#ff8b67' }],
    ['a preset with a paint', { preset: 'blue_beret', color: 'orchid' }],
    ['something that is not a character', { selections: {} }],
  ])('is refused with %s', (_label, value) => {
    expect(parseGemieCharacter(value)).toBeNull();
  });

  it('loses the paint the handle picker or an older account chose, and keeps the rest', () => {
    const picked = avatarCharacterFor('nadiabot');
    const kept = gemieCharacterOf(picked);
    expect(kept).not.toHaveProperty('color');
    expect(kept).not.toHaveProperty('bodyColor');
    expect(kept.shape).toBe(picked.shape);
    expect(gemieCharacterOf({ ...parts, bodyColor: '#ff8b67' })).toEqual(parts);
  });
});
