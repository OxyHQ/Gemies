/**
 * The connectors store's health check: does a remote MCP server answer, and how does a person
 * sign in to it?
 *
 * Asked by the API's catalogue job for each synced server (`lib/connector-catalogue/health.ts`),
 * for no account. Every request leaves through `connectorFetch` — each address judged, https only —
 * like any connector's, and nothing is stored here: no session, no token, no client.
 *
 * - The server is first `initialize`d without a token. One that answers then lists its tools
 *   (`tools/list`): it needs no sign-in, and its tools and `serverInfo` go back to the API, which
 *   judges them (the descriptions are the server's, untrusted).
 * - One that answers 401 wants OAuth: its protected-resource metadata (RFC 9728) and its
 *   authorization server's metadata (RFC 8414 / OpenID Connect) are read, and the answer says
 *   whether the server takes Dynamic Client Registration (`registration_endpoint`), the only way
 *   Gemies signs in to a provider that issued it no client.
 * - Anything else, or no answer within the deadline, is a failure with its reason.
 *
 * A reason describes the failure (`answered HTTP 502 (content-type text/html)`, `answered with a
 * body that is not JSON`), never quotes what the server sent: a server's bytes are not a message to
 * store or show.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  UnauthorizedError,
  discoverOAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { errorMessage } from '../shared/utils';
import { connectorFetch } from './connector-fetch';
import type { HostedTransport, McpServerIcon } from './types';

/** The whole check, connection and listing together. */
const PROBE_TIMEOUT_MS = 15_000;
/** More tools than any server needs to be judged by. */
const MAX_TOOLS = 500;

export type ProbeResult =
  | {
      outcome: 'open';
      tools: { name: string; description: string }[];
      server: { name?: string; websiteUrl?: string; icons?: McpServerIcon[] };
    }
  | { outcome: 'oauth'; registration: boolean }
  | { outcome: 'failed'; reason: string };

/** The last answer's content type, which a failure's reason names. */
interface Seen {
  contentType: string | null;
}

/** `connectorFetch`, remembering each answer's content type in `seen`. */
function watchedFetch(seen: Seen, signal?: AbortSignal): FetchLike {
  return async (input, init) => {
    const response = await connectorFetch(input, signal ? { ...init, signal } : init);
    seen.contentType = response.headers.get('content-type');
    return response;
  };
}

function contentTypeNote(seen: Seen): string {
  const contentType = seen.contentType?.split(';')[0].trim().slice(0, 80);
  return contentType ? ` (content-type ${contentType})` : ' (no content-type)';
}

/** Why the check failed, in words of our own. */
function failureReason(err: unknown, seen: Seen): string {
  if (err instanceof SyntaxError)
    return `answered with a body that is not JSON${contentTypeNote(seen)}`;
  if ((err instanceof StreamableHTTPError || err instanceof SseError) && (err.code ?? 0) >= 400) {
    return `answered HTTP ${err.code}${contentTypeNote(seen)}`;
  }
  return errorMessage(err).slice(0, 300);
}

function unauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  if (err instanceof StreamableHTTPError) return err.code === 401;
  return err instanceof SseError && err.code === 401;
}

async function oauthRegistration(url: URL, timeoutMs: number): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const seen: Seen = { contentType: null };
  const fetchFn = watchedFetch(seen, signal);
  try {
    const info = await discoverOAuthServerInfo(url, { fetchFn });
    if (!info.authorizationServerMetadata) {
      return { outcome: 'failed', reason: 'asks for a sign-in but publishes no OAuth metadata' };
    }
    return {
      outcome: 'oauth',
      registration: Boolean(info.authorizationServerMetadata.registration_endpoint),
    };
  } catch (err: unknown) {
    return { outcome: 'failed', reason: `OAuth metadata: ${failureReason(err, seen)}` };
  }
}

export async function probeConnector(
  rawUrl: string,
  transport: HostedTransport,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const url = new URL(rawUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  const seen: Seen = { contentType: null };
  const options = { fetch: watchedFetch(seen), requestInit: { signal } };
  const clientTransport =
    transport === 'streamable-http'
      ? new StreamableHTTPClientTransport(url, options)
      : new SSEClientTransport(url, options);
  const client = new Client(
    { name: 'gemies-catalogue-check', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(clientTransport, { signal, timeout: timeoutMs });
    const { tools } = await client.listTools(undefined, { signal, timeout: timeoutMs });
    const info = client.getServerVersion();
    return {
      outcome: 'open',
      tools: tools.slice(0, MAX_TOOLS).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
      })),
      server: {
        ...(info?.title || info?.name ? { name: info.title ?? info.name } : {}),
        ...(info?.websiteUrl ? { websiteUrl: info.websiteUrl } : {}),
        ...(info?.icons?.length
          ? {
              icons: info.icons.slice(0, 8).map((icon) => ({
                src: icon.src,
                ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
                ...(icon.sizes ? { sizes: icon.sizes } : {}),
              })),
            }
          : {}),
      },
    };
  } catch (err: unknown) {
    if (unauthorized(err)) return oauthRegistration(url, timeoutMs);
    if (signal.aborted)
      return { outcome: 'failed', reason: `no answer within ${timeoutMs / 1000} s` };
    return { outcome: 'failed', reason: failureReason(err, seen) };
  } finally {
    await client.close().catch(() => undefined);
  }
}
