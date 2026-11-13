/**
 * Where a gemie is addressed, and the pure builders of those addresses.
 *
 * A gemie with a handle is addressed by it: `/@pepe` is its thread, `/@pepe/details` its page and
 * `/@pepe/edit` its editor. One without — a gemie with no Oxy account (Gemies ADR 0036, an external
 * agent), or one whose account Oxy did not resolve — is addressed by its id: `/agents/<id>` is its
 * thread and `/agents/edit/<id>` its editor, and it has no page, since only its owner may open it.
 * The API answers the same thread either way (`GET /agents/thread/:handle`, `GET /agents/:id/thread`).
 *
 * Every address is a STRING with the `@` written out, never a route object `{ pathname:
 * '/(app)/[username]', params: { username: '@pepe' } }`: Expo Router encodes a dynamic segment's
 * value, so the object form put `/%40pepe` in the address bar.
 *
 * They live in `shared/` because chat, the sidebar and the agents' own screens all link to agents
 * and none of them may import another's feature.
 */

import type { GemieThreadAddress } from '@gemies/sdk/runtime';
import type { Href } from 'expo-router';
import type { Agent } from '@/shared/contracts/agents';

/** The fields a gemie is addressed by. */
type AgentAddressFields = Pick<Agent, '_id' | 'handle'>;

/** The handle to SHOW, without the `@`. Empty when the gemie has none. */
export function agentHandle(agent: Pick<Agent, 'handle'>): string {
  return agent.handle?.trim() ?? '';
}

/** Which thread a gemie's address names: its handle, or its id when it has none. */
export function gemieThreadAddress(agent: AgentAddressFields): GemieThreadAddress {
  const handle = agentHandle(agent);
  return handle === '' ? { gemieId: agent._id } : { handle };
}

/**
 * The address of a gemie's permanent thread: `/@pepe` or `/agents/<id>`, with `?threadId=…` for one
 * stretch.
 *
 * A STRING, never a route object, for the reason above. Every link to a thread goes through here,
 * so no screen spells it a second way.
 */
export function agentThreadHref(thread: GemieThreadAddress, threadId?: string): Href {
  const path =
    'handle' in thread ? `/@${thread.handle}` : `/agents/${encodeURIComponent(thread.gemieId)}`;
  return (
    threadId === undefined ? path : `${path}?threadId=${encodeURIComponent(threadId)}`
  ) as Href;
}

/** Where "Chat" with this gemie goes: its thread. */
export function agentChatRoute(agent: AgentAddressFields): Href {
  return agentThreadHref(gemieThreadAddress(agent));
}

/** The address of a gemie's page, `/@pepe/details`, or `null`: one with no handle has none. */
export function agentDetailsRoute(agent: AgentAddressFields): `/@${string}/details` | null {
  const handle = agentHandle(agent);
  return handle === '' ? null : `/@${handle}/details`;
}

/** The address of a gemie's editor screen (a phone's): `/@pepe/edit`, or `/agents/edit/<id>`. */
export function agentEditRoute(agent: AgentAddressFields): Href {
  const handle = agentHandle(agent);
  return (
    handle === '' ? `/agents/edit/${encodeURIComponent(agent._id)}` : `/@${handle}/edit`
  ) as Href;
}

/**
 * The gemie whose thread a path is, among `agents`: `/@pepe` by handle, `/agents/<id>` by id. The
 * reverse of {@link agentThreadHref}, beside it so the two spell the addresses one way.
 */
export function gemieOfThreadPath<T extends AgentAddressFields>(
  pathname: string,
  agents: readonly T[] | undefined,
): T | undefined {
  const handle = /^\/@([^/]+)$/.exec(pathname)?.[1];
  if (handle !== undefined) {
    const wanted = decodeURIComponent(handle);
    return agents?.find((agent) => agentHandle(agent) === wanted);
  }
  const gemieId = /^\/agents\/([^/]+)$/.exec(pathname)?.[1];
  if (gemieId !== undefined) {
    const wanted = decodeURIComponent(gemieId);
    return agents?.find((agent) => agent._id === wanted);
  }
  return undefined;
}
