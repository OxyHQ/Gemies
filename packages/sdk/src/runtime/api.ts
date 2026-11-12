import { useOxy } from '@oxy.so/services/ui/client';
import { useMemo } from 'react';
import {
  type AppAssertionHeaders,
  NO_APP_ASSERTION,
  useAppAssertionHeaders,
} from './app-assertion';
import { useGemieRuntime } from './config';

/**
 * A refusal or failure from the Gemies API, shaped so the helpers in
 * `error-utils.ts` read it: `status`, and the parsed body under
 * `response.data`.
 */
export class GemieApiError extends Error {
  readonly status: number;
  readonly response: { status: number; data: unknown };

  constructor(status: number, data: unknown, message?: string) {
    super(message ?? `Alia request failed with status ${status}.`);
    this.name = 'GemieApiError';
    this.status = status;
    this.response = { status, data };
  }
}

export interface GemieApiResult<T> {
  status: number;
  data: T;
}

export interface GemieApiRequest {
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Alia's REST API for the signed-in person. Authentication, the preflight
 * refresh and the single 401 replay belong to the linked Oxy client; this
 * layer never reads or writes a bearer itself.
 */
export interface GemieApi {
  get<T>(path: string, request?: GemieApiRequest): Promise<GemieApiResult<T>>;
  post<T>(path: string, body?: unknown, request?: GemieApiRequest): Promise<GemieApiResult<T>>;
  patch<T>(path: string, body?: unknown, request?: GemieApiRequest): Promise<GemieApiResult<T>>;
  /** Replaces a resource whole, for the routes that take PUT (the memory profile's sections). */
  put<T>(path: string, body?: unknown, request?: GemieApiRequest): Promise<GemieApiResult<T>>;
  delete<T>(path: string, request?: GemieApiRequest): Promise<GemieApiResult<T>>;
}

function withParams(path: string, params: GemieApiRequest['params']): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.append(key, String(value));
  }
  const query = search.toString();
  return query === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The structural slice of `OxyServices` the API layer needs. */
export interface LinkableOxy {
  createLinkedClient(config: { baseURL: string }): {
    client: {
      requestAuthenticatedResponse(config: {
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        url: string;
        body?: string;
        headers?: Record<string, string>;
        signal?: AbortSignal;
        fetch?: typeof fetch;
      }): Promise<Response>;
    };
    dispose(): void;
  };
}

/**
 * Build the API over an Oxy client for `apiUrl`. Exposed for tests and for non-React callers.
 *
 * @param appAssertionHeaders the host's `X-Oxy-App-Assertion` (`app-assertion.ts`), on every request
 */
export function createGemieApi(
  oxyServices: LinkableOxy,
  apiUrl: string,
  appAssertionHeaders: AppAssertionHeaders = NO_APP_ASSERTION,
): GemieApi {
  async function send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    request: GemieApiRequest = {},
  ): Promise<GemieApiResult<T>> {
    const assertion = await appAssertionHeaders();
    const linked = oxyServices.createLinkedClient({ baseURL: apiUrl });
    try {
      const headers = {
        ...assertion,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      };
      const response = await linked.client.requestAuthenticatedResponse({
        method,
        url: withParams(path, request.params),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const data = await readBody(response);
      if (!response.ok) throw new GemieApiError(response.status, data);
      return { status: response.status, data: data as T };
    } finally {
      linked.dispose();
    }
  }

  return {
    get: (path, request) => send('GET', path, request),
    post: (path, body, request) => send('POST', path, { ...request, body: body ?? {} }),
    patch: (path, body, request) => send('PATCH', path, { ...request, body: body ?? {} }),
    put: (path, body, request) => send('PUT', path, { ...request, body: body ?? {} }),
    delete: (path, request) => send('DELETE', path, request),
  };
}

/** Alia's REST API for the nearest runtime's `apiUrl`, as the signed-in person. */
export function useGemieApi(): GemieApi {
  const { oxyServices } = useOxy();
  const { apiUrl } = useGemieRuntime();
  const appAssertionHeaders = useAppAssertionHeaders();
  return useMemo(
    () => createGemieApi(oxyServices as LinkableOxy, apiUrl, appAssertionHeaders),
    [oxyServices, apiUrl, appAssertionHeaders],
  );
}
