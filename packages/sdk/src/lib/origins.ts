/**
 * The two origins the SDK talks to, defined once. Every URL it builds starts from one of them,
 * and `@gemies/sdk/csp` (`src/csp.ts`) derives the host's CSP from these same values, so an
 * origin the SDK uses is an origin it declares.
 */

// Declared here, not taken from the host's globals: Expo apps get `process` from Expo's types, a
// Vite app has none unless it installs Node's, and every entry that reaches this file must
// type-check alone (`check:entry-types`). Type-only; Metro still inlines the static access below.
declare const process: { readonly env: { readonly EXPO_PUBLIC_GEMIES_API_URL?: string } };

/** The Gemies API: `EXPO_PUBLIC_GEMIES_API_URL`, then production. Chat, dictation, speech, voice. */
export const GEMIES_API_URL = process.env.EXPO_PUBLIC_GEMIES_API_URL ?? 'https://api.gemies.ai';

/**
 * The Gemies web app, which serves the files the SDK shares with every host: the voice call's
 * worklets (`/sdk/voice-worklets/`), with CORS open (`packages/app/worker/index.js`).
 */
export const GEMIES_WEB_ORIGIN = 'https://gemies.ai';

/**
 * The one public page of a shared conversation, on the Gemies web app, for every agent and every app
 * that embeds one (`docs/agent-embedding.md` §6). An app shares this URL rather than a page of its
 * own, so a link reads the same wherever it was minted.
 */
export function gemiesSharedConversationUrl(token: string): string {
  return `${GEMIES_WEB_ORIGIN}/shared/${encodeURIComponent(token)}`;
}
