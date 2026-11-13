import { describe, expect, it } from 'vitest';
import {
  externalAgentCredentialMatches,
  generateExternalAgentCredential,
  hashExternalAgentCredential,
} from '../credential.js';

describe('external agent credentials (ADR 0038)', () => {
  it('are prefixed, 256-bit and never repeat', () => {
    const credentials = new Set(Array.from({ length: 500 }, generateExternalAgentCredential));
    expect(credentials.size).toBe(500);
    for (const credential of credentials) expect(credential).toMatch(/^gxa_[A-Za-z0-9_-]{43}$/);
  });

  it('match only their own hash', () => {
    const credential = generateExternalAgentCredential();
    const hash = hashExternalAgentCredential(credential);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(externalAgentCredentialMatches(credential, hash)).toBe(true);
    expect(externalAgentCredentialMatches(generateExternalAgentCredential(), hash)).toBe(false);
    expect(externalAgentCredentialMatches(hash, hash)).toBe(false);
    expect(externalAgentCredentialMatches(undefined, hash)).toBe(false);
    expect(externalAgentCredentialMatches(credential, 'short')).toBe(false);
  });
});
