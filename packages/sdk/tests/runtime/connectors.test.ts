import { describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../../src/runtime/api', () => ({ useGemieApi: () => ({}) }));
vi.mock('../../src/runtime/config', () => ({
  useGemieRuntime: () => ({ apiUrl: 'https://api.gemies.ai' }),
}));

const { connectionOfTool, signInResult } = await import('../../src/runtime/connectors');
import type { Connection } from '../../src/runtime/connectors';

function connection(name: string, accountLabel: string | null): Connection {
  return {
    _id: `id-${name}`,
    name,
    displayName: 'Notion',
    description: null,
    accountLabel,
    source: 'registry',
    registryId: 'notion',
    config: {},
    status: 'running',
    statusMessage: null,
    tools: [],
    logoUrl: null,
    usedBy: [],
  };
}

describe('which account a tool belongs to', () => {
  const accounts = [connection('notion', 'ana@acme.com'), connection('notion_2', 'Home')];

  it('reads the account from the tool name, so two accounts of one connector stay apart', () => {
    expect(connectionOfTool(accounts, 'mcp_notion__search')?.accountLabel).toBe('ana@acme.com');
    expect(connectionOfTool(accounts, 'mcp_notion_2__search')?.accountLabel).toBe('Home');
  });

  it('matches a custom server whose slug has characters the tool name cannot', () => {
    expect(connectionOfTool([connection('my-server', null)], 'mcp_my_server__open')?.name).toBe(
      'my-server',
    );
  });

  it('is nothing for a tool that is not a connector’s', () => {
    expect(connectionOfTool(accounts, 'webSearch')).toBeUndefined();
    expect(connectionOfTool(accounts, 'mcp_notion')).toBeUndefined();
    expect(connectionOfTool(undefined, 'mcp_notion__search')).toBeUndefined();
  });
});

describe('the result a sign-in returned with', () => {
  it('reads state and code, or the error', () => {
    expect(signInResult({ mcp_oauth_state: 's', mcp_oauth_code: 'c' })).toEqual({
      state: 's',
      code: 'c',
    });
    expect(signInResult(new URLSearchParams('mcp_oauth_error=access_denied'))).toEqual({
      error: 'access_denied',
    });
    expect(signInResult({})).toBeNull();
    expect(signInResult({ mcp_oauth_state: 's' })).toBeNull();
  });
});
