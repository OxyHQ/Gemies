import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * An external agent's credential (ADR 0038): what its daemon presents on `/ws/external-agent`.
 *
 * It is minted when a pairing code is redeemed, returned once, and stored only as its SHA-256 on the
 * agent's link. It opens that one agent's connection and nothing else: no route reads it, and it is
 * not an Oxy session. Revoking the agent kills it (the link is the only place it is checked), and
 * reconnecting the agent replaces it.
 *
 * 32 random bytes, so a plain SHA-256 is the right hash: there is nothing to brute-force. The prefix
 * makes a leaked one recognisable to a secret scanner.
 */
const CREDENTIAL_PREFIX = 'gxa_';

export function generateExternalAgentCredential(): string {
  return `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashExternalAgentCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

/** Constant-time: a byte-by-byte comparison would tell a guesser how much of the hash it had right. */
export function externalAgentCredentialMatches(credential: unknown, storedHash: string): boolean {
  if (typeof credential !== 'string' || !credential.startsWith(CREDENTIAL_PREFIX)) return false;
  const presented = Buffer.from(hashExternalAgentCredential(credential), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
