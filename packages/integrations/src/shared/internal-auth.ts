import type { Request, Response, NextFunction } from 'express';
import { isLiveEntityId } from '@oxy.so/db';
import {
  GEMIES_SERVICE_AUDIENCE,
  GEMIES_API_WORKLOAD_ID,
  GEMIES_ACCOUNT_CONTEXT_HEADER,
  isGemiesWorkload,
} from '@gemies/server/internal';
import { createLogger } from './logger';
import { oxy } from './oxy';

const logger = createLogger('internal-auth');

const verifiedRequests = new WeakSet<object>();

/** Alia's own audience is the server's (`shared/oxy.ts`). */
const serviceAuth = oxy.middleware.service();
const expectedWorkload = () => process.env.GEMIES_API_WORKLOAD_ID || GEMIES_API_WORKLOAD_ID;

/** Same-product process authentication. This never fabricates an Oxy user session. */
export async function requireAliaApi(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    ['x-oxy-user-id', 'x-oxy-requester-token', 'x-oxy-task-id'].some(
      (key) => req.headers[key] !== undefined,
    )
  ) {
    logger.warn(`Refused ${req.method} ${req.path}: a user header on an internal request`);
    res.status(403).json({ error: 'Use internal account context for Alia operations' });
    return;
  }
  await serviceAuth(req, res, () => {
    const principal = (
      req as Request & { serviceApp?: { authority?: string; appId: string; credentialId: string } }
    ).serviceApp;
    if (
      !isGemiesWorkload(
        principal && { ...principal, applicationId: principal.appId },
        expectedWorkload(),
      )
    ) {
      // Said in the log, never only to the caller: a refused API is otherwise a silent failure of
      // every linking, chat and MCP call it makes.
      logger.warn(
        `Refused ${req.method} ${req.path}: not the API workload (app ${principal?.appId ?? 'none'}, credential ${principal?.credentialId ?? 'none'})`,
      );
      res.status(403).json({ error: 'Alia API workload required' });
      return;
    }
    verifiedRequests.add(req);
    next();
  });
}

export function internalAccount(req: Pick<Request, 'headers'>): string | undefined {
  if (!verifiedRequests.has(req)) return undefined;
  const value = req.headers[GEMIES_ACCOUNT_CONTEXT_HEADER];
  return typeof value === 'string' && isLiveEntityId(value) ? value : undefined;
}

export function requireAccountContext(req: Request, res: Response, next: NextFunction): void {
  if (!internalAccount(req)) {
    logger.warn(`Refused ${req.method} ${req.path}: no valid internal account context`);
    res.status(401).json({ error: 'Internal account context required' });
    return;
  }
  next();
}

/** Shared Oxy introspection verifies live signature, audience, registry and revocation for upgrades. */
export async function authorizeInternalUpgrade(
  headers: Request['headers'],
): Promise<string | null> {
  const authorization = headers.authorization;
  if (headers['x-oxy-user-id'] !== undefined || headers['x-oxy-requester-token'] !== undefined)
    return null;
  const context = headers[GEMIES_ACCOUNT_CONTEXT_HEADER];
  const accountId = typeof context === 'string' && isLiveEntityId(context) ? context : undefined;
  if (!accountId || typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
    return null;
  try {
    const principal = await oxy.introspectServiceToken(authorization.slice(7));
    return principal.active &&
      principal.audience === GEMIES_SERVICE_AUDIENCE &&
      isGemiesWorkload(principal, expectedWorkload())
      ? accountId
      : null;
  } catch {
    return null;
  }
}
