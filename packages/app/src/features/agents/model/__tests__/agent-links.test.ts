import { describe, expect, it, vi } from 'vitest';

// The share content is pure; what hands it to the platform is not loaded for real.
vi.mock('@/features/chat/runtime/conversation-share', () => ({ deliverShareLink: vi.fn() }));

import { agentCategoryLabel } from '@/features/agents/model/category';
import { agentChatRoute, agentThreadHref } from '@/shared/routing/agent-address';
import { agentShareContent } from '@/features/agents/runtime/share-agent';
import { translator } from '@/shared/testing/translate';

/**
 * Where an agent's buttons go, as data (#608, rule 6): each of these was a
 * control whose press did something other than what it said.
 */

describe('Chat, on a catalogue card', () => {
  it('opens the agent’s own thread, not the profile the card already opens', () => {
    expect(agentChatRoute({ _id: 'a1', handle: 'pepe' })).toBe('/@pepe');
  });

  it('keeps the @ in the address: a path, not a route object whose value Expo Router encodes', () => {
    const route = agentChatRoute({ _id: 'a1', handle: 'pepe' });
    expect(typeof route).toBe('string');
    expect(route).not.toContain('%40');
    expect(agentThreadHref({ handle: 'pepe' }, 'th 1')).toBe('/@pepe?threadId=th%201');
  });

  it('opens a gemie with no handle by its id', () => {
    expect(agentChatRoute({ _id: 'a1', handle: null })).toBe('/agents/a1');
    expect(agentChatRoute({ _id: 'a1', handle: '  ' })).toBe('/agents/a1');
  });
});

describe('Share', () => {
  it('links to the gemie on the Gemies domain', () => {
    const content = agentShareContent({
      _id: 'a1',
      name: 'Pepe',
      handle: 'pepe',
      tagline: 'Finds flights',
    });
    expect(content).toEqual({
      url: 'https://gemies.ai/@pepe/details',
      title: 'Pepe',
      text: 'Pepe — Finds flights',
    });
    expect(content?.url).not.toContain('alia.app');
  });

  it('has nothing to share for a gemie with no handle: it has no page to link to', () => {
    expect(agentShareContent({ _id: 'a1', name: 'Pepe', handle: null, tagline: '' })).toBeNull();
  });

  it('never prints a null name', () => {
    const content = agentShareContent({ _id: 'a1', name: null, handle: 'pepe', tagline: '' });
    expect(content).toEqual({
      url: 'https://gemies.ai/@pepe/details',
      title: 'pepe',
      text: 'pepe',
    });
  });
});

describe('an agent’s category', () => {
  it('is shown in the reader’s language, and an unknown one as stored', () => {
    expect(agentCategoryLabel('Research', translator('es'))).toBe('Investigación');
    expect(agentCategoryLabel('Research', translator('en'))).toBe('Research');
    expect(agentCategoryLabel('Gardening', translator('es'))).toBe('Gardening');
  });
});
