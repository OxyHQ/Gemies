import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Which account a provider authorized, as a person reads it, when its token
 * response says so: the OpenID Connect `id_token` claims (`email`, then
 * `preferred_username`, then `name`). The token came straight from the
 * provider's token endpoint over TLS, and the label is only shown to the person
 * who connected, so it is read without verifying the signature; nothing is
 * authorized by it. A provider that sends no `id_token` names no account, and
 * the person names it instead.
 */
export function accountLabelOf(tokens: OAuthTokens | undefined): string | undefined {
  const payload = tokens?.id_token?.split('.')[1];
  if (!payload) return undefined;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
  for (const claim of ['email', 'preferred_username', 'name']) {
    const value = claims[claim];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  return undefined;
}
