import type { Request } from 'express';

/**
 * Whose conversation a turn is saved to: the signed-in person's, or, for a verified channel turn (a
 * connected account, a gemie bot's person), the channel's own account. A channel request carries
 * no `req.user` by design, and reading only that one left every channel turn unsaved: the thread
 * never grew, the app never showed it, and the model kept reading the same stale history.
 */
export function turnOwnerId(req: Request): string | undefined {
  return req.user?.id ?? req.channelContext?.accountId;
}
