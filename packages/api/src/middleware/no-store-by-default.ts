import type { NextFunction, Request, Response } from 'express';

/**
 * No response is stored by a browser unless its route says otherwise.
 *
 * Almost every answer here is one person's data, and a browser's HTTP cache cannot tell accounts
 * apart. Saying so on every response is also what lets the clients (`receiverSendsNoStore` on
 * their linked client, `@oxy.so/core` >= 7.50) use the default fetch cache mode, and with it the
 * CORS preflight cache: Chromium ignores `Access-Control-Max-Age` for a `no-store` request, so
 * every bearer request from the web app went out twice (2026-11-13). A route that is safe to cache
 * overrides it: capability-addressed media (`routes/media.ts`, the link is the credential) and
 * public connector icons (`routes/mcp.ts`).
 */
export function noStoreByDefault(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
