import { describe, expect, it } from 'vitest';
import {
  claudeMcpArgs,
  claudeToolArgs,
  codexToolArgs,
  gemieToolsUrl,
  opencodeToolsEnv,
  toolsEnv,
} from '../gemie-tools.js';

/**
 * The gemie's tools reach each CLI as the MCP server `gemies` of the run (Gemies ADR 0039), with the
 * credential in the environment and never on the command line.
 */
const tools = { url: 'https://api.gemies.ai/mcp/agents/agent-1', credential: 'gxa_secret' };

describe('gemie tools for a run', () => {
  it('address the agent’s own tool server', () => {
    expect(gemieToolsUrl('https://api.gemies.ai', 'agent-1')).toBe(tools.url);
  });

  it('keep the credential off every command line', () => {
    for (const args of [claudeToolArgs(tools), codexToolArgs(tools)]) {
      expect(args.join(' ')).not.toContain('gxa_secret');
    }
    expect(toolsEnv(tools, { PATH: '/bin' })).toEqual({
      PATH: '/bin',
      GEMIES_AGENT_CREDENTIAL: 'gxa_secret',
    });
  });

  it('give Claude Code the server, its header from the environment, and its tools allowed', () => {
    const [flag, config, allow, server] = claudeToolArgs(tools);
    expect([flag, allow, server]).toEqual(['--mcp-config', '--allowedTools', 'mcp__gemies']);
    expect(JSON.parse(config)).toEqual({
      mcpServers: {
        gemies: {
          type: 'http',
          url: tools.url,
          headers: { Authorization: 'Bearer ${GEMIES_AGENT_CREDENTIAL}' },
        },
      },
    });
  });

  it('give Codex config overrides that read the bearer from the environment', () => {
    expect(codexToolArgs(tools)).toEqual([
      '-c',
      `mcp_servers.gemies.url="${tools.url}"`,
      '-c',
      'mcp_servers.gemies.bearer_token_env_var="GEMIES_AGENT_CREDENTIAL"',
    ]);
  });

  it('give OpenCode the server merged into the config the person already passes', () => {
    const env = opencodeToolsEnv(tools, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'x', mcp: { mine: { type: 'local' } } }),
    });
    expect(env.GEMIES_AGENT_CREDENTIAL).toBe('gxa_secret');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'x',
      mcp: {
        mine: { type: 'local' },
        gemies: {
          type: 'remote',
          url: tools.url,
          headers: { Authorization: 'Bearer {env:GEMIES_AGENT_CREDENTIAL}' },
        },
      },
    });
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('gxa_secret');
  });

  describe('on a turn of the person’s chat (Gemies ADR 0042)', () => {
    const inChat = { ...tools, conversationId: 'chat-1' };

    it('carry the chat in the environment, never on a command line', () => {
      expect(toolsEnv(inChat, { PATH: '/bin' })).toEqual({
        PATH: '/bin',
        GEMIES_AGENT_CREDENTIAL: 'gxa_secret',
        GEMIES_CONVERSATION: 'chat-1',
      });
      for (const args of [claudeToolArgs(inChat), codexToolArgs(inChat)]) {
        expect(args.join(' ')).not.toContain('chat-1');
      }
    });

    it('send it as X-Gemies-Conversation from every CLI', () => {
      expect(JSON.parse(claudeToolArgs(inChat)[1]!).mcpServers.gemies.headers).toEqual({
        Authorization: 'Bearer ${GEMIES_AGENT_CREDENTIAL}',
        'X-Gemies-Conversation': '${GEMIES_CONVERSATION}',
      });
      expect(codexToolArgs(inChat).slice(4)).toEqual([
        '-c',
        'mcp_servers.gemies.env_http_headers={ "X-Gemies-Conversation" = "GEMIES_CONVERSATION" }',
      ]);
      const env = opencodeToolsEnv(inChat, {});
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).mcp.gemies.headers).toEqual({
        Authorization: 'Bearer {env:GEMIES_AGENT_CREDENTIAL}',
        'X-Gemies-Conversation': '{env:GEMIES_CONVERSATION}',
      });
      expect(env.GEMIES_CONVERSATION).toBe('chat-1');
    });

    it('drop a chat a previous run left in the environment when the turn names none', () => {
      expect(toolsEnv(tools, { GEMIES_CONVERSATION: 'old' })).not.toHaveProperty(
        'GEMIES_CONVERSATION',
      );
    });
  });
});

describe('claudeMcpArgs', () => {
  const tools = { url: 'https://api.gemies.ai/mcp/agents/a1', credential: 'gxa_secret' };
  const approvals = { url: 'http://127.0.0.1:41000/approve/abc', token: 'tok_secret' };

  it('is empty when the run has neither tools nor a way to ask', () => {
    expect(claudeMcpArgs({})).toEqual([]);
  });

  it('adds the local approval server as the permission prompt tool, beside Gemies’ tools', () => {
    const args = claudeMcpArgs({ tools, approvals });
    expect(args.slice(0, 2)).toEqual(['--permission-prompt-tool', 'mcp__gemies_approval__approve']);
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    expect(Object.keys(config.mcpServers)).toEqual(['gemies', 'gemies_approval']);
    expect(config.mcpServers.gemies_approval).toEqual({
      type: 'http',
      url: approvals.url,
      headers: { Authorization: 'Bearer ${GEMIES_APPROVAL_TOKEN}' },
    });
    // `--allowedTools` stays last, and names only Gemies' tools.
    expect(args.slice(-2)).toEqual(['--allowedTools', 'mcp__gemies']);
  });

  it('never puts a token on the command line', () => {
    expect(JSON.stringify(claudeMcpArgs({ tools, approvals }))).not.toMatch(/secret/);
  });

  it('can ask without Gemies’ tools', () => {
    const args = claudeMcpArgs({ approvals });
    expect(args).toContain('--permission-prompt-tool');
    expect(args).not.toContain('--allowedTools');
  });
});
