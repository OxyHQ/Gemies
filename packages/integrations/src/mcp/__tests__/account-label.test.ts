import { describe, expect, it } from 'vitest';
import { accountLabelOf } from '../account-label';

/** An unsigned JWT with these claims: the label is read, never trusted for anything. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

const tokens = (id_token?: string) => ({ access_token: 'a', token_type: 'Bearer', id_token });

describe('which account the provider authorized', () => {
  it('reads the email, then the username, then the name from the OpenID Connect claims', () => {
    expect(accountLabelOf(tokens(idToken({ email: 'ana@acme.com', name: 'Ana' })))).toBe(
      'ana@acme.com',
    );
    expect(accountLabelOf(tokens(idToken({ preferred_username: 'ana', name: 'Ana' })))).toBe('ana');
    expect(accountLabelOf(tokens(idToken({ name: 'Ana' })))).toBe('Ana');
  });

  it('names none when the token response carries no identity', () => {
    expect(accountLabelOf(tokens())).toBeUndefined();
    expect(accountLabelOf(tokens('not-a-jwt'))).toBeUndefined();
    expect(accountLabelOf(tokens(idToken({ sub: '123' })))).toBeUndefined();
    expect(accountLabelOf(undefined)).toBeUndefined();
  });
});
