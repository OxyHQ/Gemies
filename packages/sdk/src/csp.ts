/**
 * `@gemies/sdk/csp` — the Content-Security-Policy the SDK needs from a host page, in the
 * shape of `@oxy.so/core`'s `OxyCspExtensions`, so a host composes it into its own policy
 * instead of copying Alia's origins by hand:
 *
 * ```ts
 * import { withGemiesSdkCsp } from '@gemies/sdk/csp';
 * createOxySecurityHeaders({ csp: withGemiesSdkCsp(APP_CSP_EXTENSIONS) });
 * ```
 *
 * Every source is derived from `lib/origins.ts`, the values the SDK's own URLs start from, and a
 * test fails if the SDK's source names an origin this does not declare. A leaf entry: no React,
 * no React Native, safe to import from a server.
 */

import type { OxyCspDirective, OxyCspExtensions } from '@oxy.so/core/server';
import { GEMIES_API_URL, GEMIES_WEB_ORIGIN } from './lib/origins';
import { voiceSessionUrl } from './lib/voice-protocol';

const api = new URL(GEMIES_API_URL).origin;
const voiceSocket = new URL(voiceSessionUrl(GEMIES_API_URL)).origin;

/** What the SDK loads, by directive, and why. */
export const GEMIES_SDK_CSP = Object.freeze({
  // The API (chat, dictation, speech, the activity socket's polling) and its WebSocket (the
  // voice call, socket.io); the avatar runtime fetches its WebAssembly and data from the web app.
  connectSrc: Object.freeze([api, voiceSocket, GEMIES_WEB_ORIGIN]),
  // The avatar runtime and the voice call's worklets are modules served by the web app; the
  // runtime compiles WebAssembly (`'wasm-unsafe-eval'` allows that and nothing else: no eval).
  scriptSrc: Object.freeze([GEMIES_WEB_ORIGIN, "'wasm-unsafe-eval'"]),
  // Stored attachments come from the API; an attachment's preview before upload is a blob.
  imgSrc: Object.freeze([api, 'blob:']),
  // Read-aloud clips are played from the API.
  mediaSrc: Object.freeze([api]),
} satisfies OxyCspExtensions);

/**
 * The host's own CSP extensions with the SDK's added: each directive is the union, the host's
 * sources first. `@oxy.so/core` dedupes when it builds the policy.
 */
export function withGemiesSdkCsp(host: OxyCspExtensions = {}): OxyCspExtensions {
  const merged: Partial<Record<OxyCspDirective, readonly string[]>> = { ...host };
  for (const [directive, sources] of Object.entries(GEMIES_SDK_CSP) as [
    OxyCspDirective,
    readonly string[],
  ][]) {
    merged[directive] = [...(host[directive] ?? []), ...sources];
  }
  return merged;
}
