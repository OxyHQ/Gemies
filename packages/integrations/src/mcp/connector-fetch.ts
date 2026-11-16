/**
 * The one fetch every connector request leaves this host through.
 *
 * A remote connector's URL is a person's choice, and so is everything its server
 * points at afterwards: OAuth metadata, authorization servers, token and
 * revocation endpoints, redirects. This host runs inside the VPC, where the
 * cloud metadata service and every private range answer, so each of those
 * requests is made with the SDK's `safeFetch` (`@oxy.so/core/server`): every
 * hop's address is resolved and judged, and the connection is pinned to the
 * address that was judged, which closes the DNS-rebinding window a check made
 * before an ordinary `fetch` leaves open. Only https is reached.
 *
 * The MCP SDK's transports and `auth()` take a WHATWG `fetch`, so this adapts
 * the request to `safeFetch` and its Node response back to a `Response`. The
 * body is streamed, not buffered: a streamable-HTTP or SSE connection is a
 * long-lived stream, and the caller's signal still ends it.
 *
 * Like a WHATWG `fetch`, it says which content codings it reads
 * (`Accept-Encoding`) and hands the caller the decoded body: a server is free to
 * compress (some do even when not asked), and `safeFetch` returns the bytes as
 * they came. A coding it does not know leaves the body as it came, as `fetch`
 * does.
 */

import { pipeline, Readable, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { safeFetch, SsrfRejection } from '@oxy.so/core/server';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * How long a connector may take to answer with its headers. A tool call over
 * streamable HTTP may answer with plain JSON only once the tool has finished,
 * so this is the tool call's budget, not a connect timeout.
 */
const CONNECTOR_HEADERS_TIMEOUT_MS = 120_000;

/** Statuses a `Response` must be built without a body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** The content codings this fetch decodes, and what it asks for when the caller does not. */
const DECODERS: Record<string, () => Transform> = {
  gzip: createGunzip,
  'x-gzip': createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
};
const ACCEPT_ENCODING = 'gzip, deflate, br';

/**
 * The decoders for a `Content-Encoding`, in the order to apply them (the last coding applied comes
 * off first), or `null` when the body is not encoded or carries a coding this fetch does not know.
 */
function decodersFor(contentEncoding: string | null): Transform[] | null {
  const codings = (contentEncoding ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== 'identity');
  if (codings.length === 0 || !codings.every((coding) => coding in DECODERS)) return null;
  return codings.reverse().map((coding) => DECODERS[coding]());
}

export const connectorFetch: FetchLike = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).protocol !== 'https:') {
    throw new SsrfRejection('a connector is reached over https only');
  }

  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  // `forEach`, not iteration: this package's `lib` has no `DOM.Iterable`.
  const requestHeaders: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    requestHeaders[name] = value;
  });
  requestHeaders['accept-encoding'] ??= ACCEPT_ENCODING;
  const { response, status, headers } = await safeFetch(request.url, {
    method: request.method,
    headers: requestHeaders,
    ...(body ? { body } : {}),
    ...(init?.redirect === 'manual' ? { redirect: 'manual' as const } : {}),
    ...(init?.redirect === 'error' ? { maxRedirects: 0 } : {}),
    headersTimeoutMs: CONNECTOR_HEADERS_TIMEOUT_MS,
    ...(init?.signal ? { signal: init.signal } : {}),
  });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
  }

  if (NULL_BODY_STATUSES.has(status)) {
    response.destroy();
    return new Response(null, { status, headers: responseHeaders });
  }
  let decoded: Readable = response;
  const decoders =
    request.method === 'HEAD' ? null : decodersFor(responseHeaders.get('content-encoding'));
  if (decoders) {
    // `pipeline` carries an error through: a broken coding, or the caller's signal ending the body.
    pipeline([response, ...decoders], () => undefined);
    decoded = decoders[decoders.length - 1];
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
  }
  return new Response(Readable.toWeb(decoded) as ReadableStream<Uint8Array>, {
    status,
    headers: responseHeaders,
  });
};
