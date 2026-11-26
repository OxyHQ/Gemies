import { ACCOUNT, answerSource, gemieRead } from '@gemies/sdk/runtime';
import type { ApiClient } from '@/shared/api/client';
import { PERSISTED_DATA_VERSION } from '@/shared/api/persisted-data-version';
import { API_ROUTES } from '@/shared/api/routes';
import type { Agent } from '@/shared/contracts/agents';
import type { Space } from '@/shared/contracts/spaces';

/**
 * The app's own account data that a returning person's sidebar draws from the first frame: bloom-data
 * answers in the signed-in account's store (opened by Services' `OxyProvider`), copied to its
 * durable store and versioned by `PERSISTED_DATA_VERSION`. They are read with `useMyAgents` and
 * `useSpaces`; every screen or event that changes them writes or marks them stale through here,
 * the way the SDK's own data is shared (`@gemies/sdk/runtime`). Each source takes the client it
 * reads with first, like the SDK's.
 *
 * Everything else the app reads is a React Query query, in memory only (`query-keys.ts`).
 */

/**
 * The person's own agents, held whole in the signed-in account's bloom-data store and copied to
 * its durable store: the sidebar of a returning person draws them from the first frame, from what
 * they saw last, while they are read again behind it (docs/instant-loading.md). Another account
 * never reads them (each account has its own store) and a sign-out deletes them with the store.
 *
 * No timer: the account's realtime connection keeps it (`useAppRealtime`) — a thread's newest line
 * and unread count from `conversation`, a computer online or away from `presence`, a gemie made,
 * edited or deleted on any device from `gemies` — and a reconnect reads it once.
 */
export const myAgents = answerSource('alia.my-agents', {
  ...gemieRead,
  persist: { version: PERSISTED_DATA_VERSION },
  key: (_client: ApiClient) => ACCOUNT,
  stale: 5 * 60_000,
  load: async ({ signal }, client): Promise<Agent[]> => {
    const response = await client.get<{ agents: Agent[] }>(API_ROUTES.agents.me, { signal });
    return response.data.agents;
  },
});

/**
 * Rewrites the held list in the store in scope (`withStore`), as a screen or an event knows it
 * changed; nothing when the account holds no list yet (there is nothing to show the change on).
 */
export function updateMyAgents(change: (agents: Agent[]) => Agent[]): void {
  myAgents.entity.update(ACCOUNT, (held) => {
    const value = change(held.value);
    return value === held.value ? undefined : { ...held, value };
  });
}

/** The list the store in scope holds, if any. */
export function heldMyAgents(): readonly Agent[] | undefined {
  return myAgents.entity.get(ACCOUNT)?.value;
}

/** Marks the list stale in the store in scope: on screen it is read again at once. */
export function refreshMyAgents(): void {
  myAgents.invalidateAll();
}

/**
 * The person's spaces, with their members and rooms (`GET /spaces`), held in the signed-in
 * account's store and copied to its durable store like the person's agents (`myAgents`): the
 * sidebar draws them from the first frame.
 */
export const spaces = answerSource('alia.spaces', {
  ...gemieRead,
  persist: { version: PERSISTED_DATA_VERSION },
  key: (_client: ApiClient) => ACCOUNT,
  stale: 5 * 60_000,
  load: async ({ signal }, client): Promise<Space[]> => {
    const response = await client.get<{ spaces: Space[] }>(API_ROUTES.spaces.list, { signal });
    return response.data.spaces ?? [];
  },
});
