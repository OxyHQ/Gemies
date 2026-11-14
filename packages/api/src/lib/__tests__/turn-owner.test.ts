/**
 * Whose conversation a chat turn is saved to. A verified channel turn carries no `req.user` by
 * design, and reading only that left every channel turn (a connected account's, a gemie bot's
 * person's) unsaved: the thread never grew, and the model kept reading a stale history.
 */

import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { turnOwnerId } from '../chat/turn-owner.js';

describe('the owner of a chat turn', () => {
  it('is the signed-in person, or the verified channel’s account', () => {
    expect(turnOwnerId({ user: { id: 'person-1' } } as unknown as Request)).toBe('person-1');
    expect(
      turnOwnerId({
        channelContext: { kind: 'gemie_bot', accountId: 'owner-1', platform: 'telegram' },
      } as unknown as Request),
    ).toBe('owner-1');
    expect(turnOwnerId({} as Request)).toBeUndefined();
  });
});
