import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The header's participants: the lead, then the others in the conversation, drawn as they are when
 * it opens (ADR 0020 §7, ADR 0041): nobody joins a chat mid-turn.
 */

const seen = vi.hoisted(() => ({
  profiles: [] as Array<{ agents: Array<{ id: string }>; avatarHidden?: boolean }>,
}));

vi.mock('@oxy.so/bloom/agent-reply', () => ({
  AgentProfile: (props: { agents: Array<{ id: string }>; avatarHidden?: boolean }) => {
    seen.profiles.push(props);
    return null;
  },
}));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({ avatarJoinFlights: () => [] }));
vi.mock('../../src/lib/agent-character', () => ({ readAgentCharacter: (value: unknown) => value }));
vi.mock('../../src/lib/alia-character', () => ({ ALIA_AVATAR: { preset: 'alia' } }));

import { GemieParticipants } from '../../src/components/GemieParticipants';
import { ALIA_LEAD } from '../../src/lib/participants';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
async function render(element: React.ReactElement) {
  await act(async () => {
    if (renderer === null) renderer = create(element);
    else renderer.update(element);
  });
}
const drawn = () => seen.profiles.at(-1)?.agents.map((agent) => agent.id);

beforeEach(() => {
  seen.profiles = [];
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('GemieParticipants', () => {
  it('draws the lead first', async () => {
    const lead = { ...ALIA_LEAD, id: 'sindi', name: 'Sindi', isAlia: false };
    await render(<GemieParticipants participants={{ lead, joined: [] }} />);
    expect(drawn()).toEqual(['sindi']);
  });

  it('draws the others in the conversation after it, in order', async () => {
    const lead = { ...ALIA_LEAD, id: 'pepe', name: 'Pepe', isAlia: false };
    const lumen = { id: 'lumen', name: 'Lumen', character: { preset: 'lumen' } as never };
    await render(<GemieParticipants participants={{ lead, joined: [lumen] }} />);
    expect(drawn()).toEqual(['pepe', 'lumen']);
  });
});
