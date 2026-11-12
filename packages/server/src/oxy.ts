import { GEMIES_API_URL, GemieServerClient, type GemieServerClientOptions } from './client.js';
import { GEMIES_SERVICE_AUDIENCE } from './identity.js';

export type GemieOxyRequester =
  | { accountId: string; token: string; taskId?: never; requesterContext?: never }
  | { accountId: string; taskId: string; token?: never; requesterContext?: never }
  | { accountId: string; requesterContext: string; token?: never; taskId?: never };

/** Structural boundary: the SDK never loads Oxy's server implementation. */
export interface OxyServiceTransportFactory {
  createServiceClient(options: {
    baseURL: string;
    audience: typeof GEMIES_SERVICE_AUDIENCE;
    requester?: GemieOxyRequester;
  }): { fetch: typeof globalThis.fetch; dispose(): void };
}

export function createGemieTransportForOxyService(
  oxy: OxyServiceTransportFactory,
  options: { baseURL?: string; requester?: GemieOxyRequester } = {},
): { fetch: typeof globalThis.fetch; dispose(): void } {
  return oxy.createServiceClient({
    baseURL: options.baseURL ?? GEMIES_API_URL,
    audience: GEMIES_SERVICE_AUDIENCE,
    ...(options.requester === undefined ? {} : { requester: options.requester }),
  });
}

/** Alia through Oxy's workload transport, including its audience and refresh ownership. */
export function createGemieForOxyService(
  oxy: OxyServiceTransportFactory,
  options: Omit<GemieServerClientOptions, 'fetch' | 'token'> & {
    requester?: GemieOxyRequester;
  } = {},
): GemieServerClient & { dispose(): void } {
  const { requester, ...clientOptions } = options;
  const transport = createGemieTransportForOxyService(oxy, {
    baseURL: options.baseUrl ?? GEMIES_API_URL,
    ...(requester === undefined ? {} : { requester }),
  });
  return Object.assign(new GemieServerClient({ ...clientOptions, fetch: transport.fetch }), {
    dispose: () => transport.dispose(),
  });
}
