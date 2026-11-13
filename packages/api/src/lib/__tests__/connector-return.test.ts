import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ log: { general: { error: vi.fn() } } }));

const { connectorCallbackUrl, connectorReturnTarget, connectorReturnUrl } = await import(
  '../connector-return.js'
);

const WEB = 'https://gemies.ai';

describe('where a connector sign-in returns the person', () => {
  it('returns to a page of an origin the API trusts, without its query', () => {
    expect(connectorReturnTarget('https://gemies.ai/connectors?x=1#y', WEB)).toBe(
      'https://gemies.ai/connectors',
    );
    expect(connectorReturnTarget('https://alia.onl/connectors', WEB)).toBe(
      'https://alia.onl/connectors',
    );
  });

  it("returns to a native app's own scheme", () => {
    expect(connectorReturnTarget('gemies://connectors', WEB)).toBe('gemies://connectors');
    expect(connectorReturnTarget('alia://connectors?x=1', WEB)).toBe('alia://connectors');
  });

  it('is never an open redirect', () => {
    for (const asked of [
      'https://evil.test/connectors',
      'javascript:alert(1)',
      'otherapp://connectors',
      'not a url',
      42,
      undefined,
    ]) {
      expect(connectorReturnTarget(asked, WEB)).toBe('https://gemies.ai/connectors');
    }
  });

  it('carries the outcome in the query', () => {
    expect(
      connectorReturnUrl('gemies://connectors', { mcp_oauth_state: 's', mcp_oauth_code: 'c' }),
    ).toBe('gemies://connectors?mcp_oauth_state=s&mcp_oauth_code=c');
  });
});

describe('the one redirect URI every provider knows Gemies by', () => {
  it("is api.gemies.ai's in production, whatever host the API is also configured as", () => {
    expect(
      connectorCallbackUrl({ NODE_ENV: 'production', API_BASE_URL: 'https://api.alia.onl' }),
    ).toBe('https://api.gemies.ai/mcp/oauth/callback');
  });

  it("is a development API's own", () => {
    expect(
      connectorCallbackUrl({ NODE_ENV: 'development', API_BASE_URL: 'http://localhost:4150/' }),
    ).toBe('http://localhost:4150/mcp/oauth/callback');
    expect(connectorCallbackUrl({})).toBe('http://localhost:4150/mcp/oauth/callback');
  });
});
