/**
 * Where a connector's OAuth callback sends the person back.
 *
 * The provider redirects to the API (`GET /mcp/oauth/callback`, the one
 * redirect URI registered with every provider), and the API hands `state` and
 * `code` on to the app that started the flow, which finishes it with its own
 * session (`POST /mcp/oauth/complete`). That app is named when the flow starts
 * and checked here, so the callback can never be turned into an open redirect:
 *
 * - a web page of an origin the API already trusts with credentials
 *   (`appOriginsFor`: gemies.ai, alia.onl, local development), or
 * - the native apps' own schemes (`gemies://`, `alia://`), which the app's
 *   auth session (`expo-web-browser`'s `openAuthSessionAsync`) is waiting for.
 *
 * Anything else falls back to the web app's connectors store (`/connectors`).
 */

import { appOriginsFor } from './cors-origins.js';

/** The schemes of the native apps that connect connectors: Gemies and Alia. */
const NATIVE_SCHEMES = ['gemies:', 'alia:'] as const;

/** The page a flow returns to when it named none, or one that is not allowed. */
export function defaultConnectorReturn(webUrl: string | undefined = process.env.WEB_URL): string {
  return `${webUrl || 'http://localhost:8150'}/connectors`;
}

/** `returnTo` as asked, when it is a place the callback may send the person; otherwise the default. */
export function connectorReturnTarget(
  requested: unknown,
  webUrl: string | undefined = process.env.WEB_URL,
): string {
  if (typeof requested !== 'string' || requested.length > 2048 || !URL.canParse(requested)) {
    return defaultConnectorReturn(webUrl);
  }
  const url = new URL(requested);
  if ((NATIVE_SCHEMES as readonly string[]).includes(url.protocol)) {
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  if (!appOriginsFor(webUrl).includes(url.origin)) return defaultConnectorReturn(webUrl);
  return `${url.origin}${url.pathname}`;
}

/** The return target with the callback's outcome in its query. */
export function connectorReturnUrl(returnTo: string, params: Record<string, string>): string {
  const url = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
