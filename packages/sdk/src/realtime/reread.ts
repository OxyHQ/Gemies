/**
 * The reads a realtime signal makes stale, declared by the modules that own them: after a `reset`
 * (the client fell too far behind the account's event log) and on `connections` (the person's
 * connected accounts or connectors changed). The store's connection (`store.ts`) invalidates them
 * in the account's store: a read on screen is read again at once, any other when it is next shown,
 * however fresh it was.
 */

export type RereadSignal = 'reset' | 'connections';

interface Invalidates {
  invalidateAll(): void;
}

const sources: Record<RereadSignal, Set<Invalidates>> = {
  reset: new Set(),
  connections: new Set(),
};

/** Declares that `signal` makes every key of these sources stale. */
export function rereadOn(signal: RereadSignal, ...owned: Invalidates[]): void {
  for (const source of owned) sources[signal].add(source);
}

/** Marks every key of the sources `signal` names stale, in the store in scope. */
export function invalidateOn(signal: RereadSignal): void {
  for (const source of sources[signal]) source.invalidateAll();
}
