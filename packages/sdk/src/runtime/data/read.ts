import { retryAfterSecondsOf } from '@oxy.so/core';
import { errorStatus } from '../error-utils';

/**
 * The read options every Gemies source shares: the ones the Oxy SDK's React Query client gave
 * every query the runtime ran on it, before Services 15. Retry only what another attempt can
 * change (no answer at all, 408, 425, 429, 5xx), at most twice, never past a long `Retry-After`;
 * back off as the refusal asked, or exponentially; and do not read again when the app comes to the
 * front (the realtime connection keeps what is on screen current).
 *
 * bloom-data counts the first failure as 1. `stale` and any stricter `retry` stay per source.
 */

const MAX_RETRIES = 2;
/** The longest a read waits, silently, for a refusal's `Retry-After`. */
const MAX_RETRY_AFTER_MS = 30_000;

const retryAfterMs = (error: unknown): number => (retryAfterSecondsOf(error) ?? 0) * 1000;

/** Whether another attempt can change a failure: the shared rule, before any source's own. */
export function retriesRead(failureCount: number, error: unknown): boolean {
  if (failureCount > MAX_RETRIES) return false;
  if (retryAfterMs(error) > MAX_RETRY_AFTER_MS) return false;
  const status = errorStatus(error);
  if (status === undefined) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export const gemieRead = {
  retry: retriesRead,
  retryDelay: (failureCount: number, error: unknown) =>
    retryAfterMs(error) || Math.min(1000 * 2 ** (failureCount - 1), 30_000),
  refetchOnFocus: false,
} as const;

/** The key of a read the account makes once (its collections, its connected accounts). */
export const ACCOUNT = 'account';
