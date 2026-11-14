import { describe, expect, it, vi } from 'vitest';

vi.mock('@gemies/sdk', () => ({ readAgentCharacter: (character: unknown) => character }));

const { groupMembersOf } = await import('../group-members');

const agent = (id: string, name: string) =>
  ({
    _id: id,
    name,
    handle: name.toLowerCase(),
    character: { preset: 'blue_beret' },
    color: 'blue',
  }) as never;

describe('groupMembersOf', () => {
  it('lists the members in the order they answer, from the person’s own agents', () => {
    const members = groupMembersOf(['b', 'a'], [agent('a', 'Nadia'), agent('b', 'Pepe')]);
    expect(members?.map((member) => member.id)).toEqual(['b', 'a']);
    expect(members?.[0]).toMatchObject({ name: 'Pepe', handle: 'pepe' });
  });

  it('leaves out an agent this list does not hold, and stays the group however few are left', () => {
    expect(groupMembersOf(['a', 'x', 'b'], [agent('a', 'Nadia'), agent('b', 'Pepe')])).toHaveLength(
      2,
    );
    // Drawn as an ordinary chat it greeted as Alia, while what was sent went to the group.
    expect(groupMembersOf(['a', 'x'], [agent('a', 'Nadia')])?.map((member) => member.id)).toEqual([
      'a',
    ]);
    expect(groupMembersOf(['x', 'y'], [agent('a', 'Nadia')])).toEqual([]);
  });

  it('answers nothing for a conversation that is not a group, or while the agents load', () => {
    expect(groupMembersOf(undefined, [agent('a', 'Nadia')])).toBeUndefined();
    expect(groupMembersOf([], [agent('a', 'Nadia')])).toBeUndefined();
    expect(groupMembersOf(['a', 'b'], undefined)).toBeUndefined();
  });
});
