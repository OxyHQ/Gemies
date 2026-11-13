import { describe, expect, it, vi } from 'vitest';

/**
 * Bloom's two functions as they behave: a known preset key (here, any lower-case word but `nope`)
 * paints the body and drops the character's own paint; anything else leaves the character as it is.
 */
vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  avatarCharacterInColor: (character: Record<string, unknown>, color: unknown) => {
    if (typeof color !== 'string' || !/^[a-z]+$/.test(color) || color === 'nope') return character;
    const { color: _color, bodyColor: _bodyColor, ...parts } = character;
    return { ...parts, bodyColor: `#${color}` };
  },
  parseAvatarCharacter: (value: unknown) => {
    const character = value as { shape?: string; preset?: string; bodyColor?: string };
    if (character.shape === 'unknown' || character.bodyColor === undefined)
      throw new Error('Invalid avatar character.');
    return value;
  },
}));

import {
  DEFAULT_AGENT_CHARACTER,
  DEFAULT_AGENT_COLOR,
  readAgentCharacter,
  readAgentLook,
} from '../../src/lib/agent-character';
import {
  DEFAULT_AGENT_CHARACTER as entryDefault,
  readAgentCharacter as entryParser,
  readAgentLook as entryLook,
} from '../../src/character';

const look = { shape: 'heart', eyes: 'oval', eyewear: 'none', accessory: 'bow' };

describe('a gemie is drawn in its account colour', () => {
  it('exposes the same readers and default look on the character entry', () => {
    expect(entryParser).toBe(readAgentCharacter);
    expect(entryLook).toBe(readAgentLook);
    expect(entryDefault).toBe(DEFAULT_AGENT_CHARACTER);
  });

  it('paints the stored look in the account colour', () => {
    expect(readAgentCharacter(look, 'lagoon')).toEqual({ ...look, bodyColor: '#lagoon' });
  });

  it('never draws a paint a character still carries: the account colour wins', () => {
    expect(readAgentCharacter({ ...look, color: 'pink' }, 'lagoon')).toEqual({
      ...look,
      bodyColor: '#lagoon',
    });
    expect(readAgentCharacter({ ...look, bodyColor: '#ff8b67' }, null)).toEqual({
      ...look,
      bodyColor: `#${DEFAULT_AGENT_COLOR}`,
    });
  });

  it('paints in the default colour when the account colour is unknown', () => {
    for (const color of [null, undefined, 'nope']) {
      expect(readAgentCharacter(look, color)).toEqual({
        ...look,
        bodyColor: `#${DEFAULT_AGENT_COLOR}`,
      });
    }
  });

  it('falls back on the one default look, still in the account colour', () => {
    const expected = { ...DEFAULT_AGENT_CHARACTER, bodyColor: '#mint' };
    expect(readAgentCharacter(undefined, 'mint')).toEqual(expected);
    expect(readAgentCharacter('teal', 'mint')).toEqual(expected);
    expect(readAgentCharacter({ shape: 'unknown' }, 'mint')).toEqual(expected);
  });
});

describe('the look the editor edits', () => {
  it('is the stored character without a colour', () => {
    expect(readAgentLook(look)).toEqual(look);
    expect(readAgentLook({ ...look, color: 'pink' })).toEqual(look);
    expect(readAgentLook({ preset: 'blue_beret', accessory: 'none' })).toEqual({
      preset: 'blue_beret',
      accessory: 'none',
    });
  });

  it('is the default look for what cannot be drawn, and it has no colour either', () => {
    expect(readAgentLook(null)).toBe(DEFAULT_AGENT_CHARACTER);
    expect(readAgentLook({ shape: 'unknown' })).toBe(DEFAULT_AGENT_CHARACTER);
    expect(DEFAULT_AGENT_CHARACTER).not.toHaveProperty('color');
    expect(DEFAULT_AGENT_CHARACTER).not.toHaveProperty('bodyColor');
  });
});
