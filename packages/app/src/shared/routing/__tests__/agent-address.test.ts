import { describe, expect, it } from 'vitest';
import {
  agentChatRoute,
  agentDetailsRoute,
  agentEditRoute,
  agentHandle,
  agentThreadHref,
  gemieThreadAddress,
} from '@/shared/routing/agent-address';

/**
 * A gemie is addressed by its handle, as a STRING with the `@` written out: the object form
 * `{ pathname: '/(app)/[username]', params: { username: '@pepe' } }` is encoded by Expo Router and
 * put `/%40pepe` in the address bar. One with no handle — no Oxy account (ADR 0036), or one Oxy did
 * not resolve — is addressed by its id, and has no page.
 */

const pepe = { _id: 'pepe-id', handle: 'pepe' };
const local = { _id: 'local 1', handle: null };

describe('a gemie’s addresses', () => {
  it('are strings with the @ in them: the thread, the page and the editor', () => {
    expect(agentChatRoute(pepe)).toBe('/@pepe');
    expect(agentDetailsRoute(pepe)).toBe('/@pepe/details');
    expect(agentEditRoute(pepe)).toBe('/@pepe/edit');
    for (const address of [agentChatRoute(pepe), agentDetailsRoute(pepe), agentEditRoute(pepe)]) {
      expect(typeof address).toBe('string');
      expect(address).not.toContain('%40');
    }
  });

  it('carry the stretch of a thread, encoded', () => {
    expect(agentThreadHref({ handle: 'pepe' })).toBe('/@pepe');
    expect(agentThreadHref({ handle: 'pepe' }, 'th 1')).toBe('/@pepe?threadId=th%201');
    expect(agentThreadHref({ gemieId: 'g 1' }, 'th 1')).toBe('/agents/g%201?threadId=th%201');
  });

  it('read the handle trimmed, empty when there is none', () => {
    expect(agentHandle({ handle: '  pepe ' })).toBe('pepe');
    expect(agentHandle({ handle: null })).toBe('');
    expect(agentHandle({ handle: '   ' })).toBe('');
  });

  it('are by id for a gemie with no handle, which has a thread and an editor but no page', () => {
    expect(gemieThreadAddress(local)).toEqual({ gemieId: 'local 1' });
    expect(gemieThreadAddress(pepe)).toEqual({ handle: 'pepe' });
    expect(agentChatRoute(local)).toBe('/agents/local%201');
    expect(agentEditRoute(local)).toBe('/agents/edit/local%201');
    expect(agentDetailsRoute(local)).toBeNull();
    expect(agentChatRoute({ _id: 'x', handle: '   ' })).toBe('/agents/x');
  });
});
