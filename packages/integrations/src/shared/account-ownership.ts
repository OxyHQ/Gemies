import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { internalAccount } from './internal-auth';

/**
 * Hold a gateway's routes to the account the API verified (`x-alia-account-context`): a body can
 * never name another owner, and `/sessions/:sessionId…` answers only for that account's sessions
 * (another's is `404`, as if it did not exist).
 */
export function accountOwnership(
  ownerOf: (sessionId: string) => Promise<string | null>,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const accountId = internalAccount(req);
    if (!accountId) {
      res.status(401).json({ error: 'Internal account context required' });
      return;
    }
    // The API has already resolved a session/task owner. A body cannot replace it.
    if (req.body && typeof req.body === 'object') req.body.oxyUserId = accountId;
    const match = /^\/sessions\/([^/]+)/.exec(req.path);
    if (match && match[1] !== 'connect') {
      try {
        if ((await ownerOf(decodeURIComponent(match[1]))) !== accountId) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
      } catch {
        res.status(503).json({ error: 'Session unavailable' });
        return;
      }
    }
    next();
  };
}
