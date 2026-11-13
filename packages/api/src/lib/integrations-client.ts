import { createGemieTransportForOxyService } from '@gemies/server';
import { GEMIES_ACCOUNT_CONTEXT_HEADER } from '@gemies/server/internal';
import { isLiveEntityId } from '@oxy.so/db';
import { oxy } from './oxy.js';

const transports = new Map<string, ReturnType<typeof createGemieTransportForOxyService>>();

function transportFor(baseURL: string) {
  let transport = transports.get(baseURL);
  if (!transport) {
    transport = createGemieTransportForOxyService(oxy, { baseURL });
    transports.set(baseURL, transport);
  }
  return transport;
}

/** No caller-supplied identity ever crosses to the integrations process. */
function internalHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  headers.delete('x-oxy-user-id');
  headers.delete('x-oxy-requester-token');
  headers.delete('x-gateway-secret');
  return headers;
}

/** Internal product context, derived by the API from a session/task or an owned connector row.
 * It is never an Oxy user authentication header and is not forwarded to another product. */
export async function integrationsFetch(
  accountId: string,
  path: string,
  init: RequestInit = {},
  baseURL = process.env.INTEGRATIONS_URL,
): Promise<Response> {
  if (!baseURL || !isLiveEntityId(accountId))
    throw new Error('Integrations account context unavailable');
  const headers = internalHeaders(init);
  headers.set(GEMIES_ACCOUNT_CONTEXT_HEADER, accountId);
  return transportFor(baseURL).fetch(path, { ...init, headers });
}

/**
 * A call that acts for no account: Telegram's webhook deliveries, and setting a gemie's own bot up
 * (ADR 0037). Authenticated as the API workload, like every call; the routes it reaches take no
 * account context.
 */
export async function integrationsServiceFetch(
  path: string,
  init: RequestInit = {},
  baseURL = process.env.INTEGRATIONS_URL,
): Promise<Response> {
  if (!baseURL) throw new Error('The integrations service is not configured');
  return transportFor(baseURL).fetch(path, { ...init, headers: internalHeaders(init) });
}
