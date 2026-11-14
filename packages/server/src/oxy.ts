import { GEMIES_API_URL, GemieServerClient, type GemieServerClientOptions } from './client.js';
import { GEMIES_SERVICE_AUDIENCE } from './identity.js';

/**
 * The account an Oxy service calls Gemies for, and the person when they operate that account rather
 * than own it (a bot, an organization). Oxy checks the calling service's declared authority live on
 * every request (oxy ADR 0066): no session, task or proof is carried.
 */
export interface GemieActingFor {
  accountId: string;
  requesterAccountId?: string;
}

/** Structural boundary: the SDK never loads Oxy's server implementation. */
export interface OxyServiceTransportFactory {
  createServiceClient(options: {
    baseURL: string;
    audience: typeof GEMIES_SERVICE_AUDIENCE;
    actingFor?: GemieActingFor;
  }): { fetch: typeof globalThis.fetch; dispose(): void };
}

export function createGemieTransportForOxyService(
  oxy: OxyServiceTransportFactory,
  options: { baseURL?: string; actingFor?: GemieActingFor } = {},
): { fetch: typeof globalThis.fetch; dispose(): void } {
  return oxy.createServiceClient({
    baseURL: options.baseURL ?? GEMIES_API_URL,
    audience: GEMIES_SERVICE_AUDIENCE,
    ...(options.actingFor === undefined ? {} : { actingFor: options.actingFor }),
  });
}

/** Gemies through Oxy's workload transport, including its audience and refresh ownership. */
export function createGemieForOxyService(
  oxy: OxyServiceTransportFactory,
  options: Omit<GemieServerClientOptions, 'fetch' | 'token'> & {
    actingFor?: GemieActingFor;
  } = {},
): GemieServerClient & { dispose(): void } {
  const { actingFor, ...clientOptions } = options;
  const transport = createGemieTransportForOxyService(oxy, {
    baseURL: options.baseUrl ?? GEMIES_API_URL,
    ...(actingFor === undefined ? {} : { actingFor }),
  });
  return Object.assign(new GemieServerClient({ ...clientOptions, fetch: transport.fetch }), {
    dispose: () => transport.dispose(),
  });
}
