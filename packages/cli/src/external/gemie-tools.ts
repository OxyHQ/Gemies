/**
 * The gemie's tools, handed to the CLI on every turn (Gemies ADR 0039).
 *
 * Gemies serves each external agent's granted tools as a remote MCP server at
 * `<api>/mcp/agents/<agentId>`, opened by the agent's own credential. Each run of the CLI gets that
 * server as `gemies` through the CLI's own MCP configuration for that run — Claude Code's
 * `--mcp-config`, Codex's `-c mcp_servers.*`, OpenCode's `OPENCODE_CONFIG_CONTENT` — and never by
 * writing the person's config files: the tools belong to the gemie's turns, not to every session the
 * person opens, and revoking the agent leaves nothing behind to clean.
 *
 * The credential travels in the child's environment and the config only names the variable, so it
 * is never on a command line (`ps` shows those to every user of the machine). The tools run in
 * Gemies; nothing runs here but the CLI.
 *
 * A turn of the person's chat with the agent also names that chat (`X-Gemies-Conversation`, the
 * relay's `threadKey`), the same way, from the environment: with it the agent can write to the
 * person's other gemies, and the answer comes back to that chat (Gemies ADR 0042). Gemies checks
 * the conversation is the owner's chat with this agent; a turn that names none simply cannot.
 */

export interface GemieTools {
  /** `<api>/mcp/agents/<agentId>`. */
  readonly url: string;
  /** The agent's credential, which opens that server and nothing else. */
  readonly credential: string;
  /** The person's chat this turn belongs to (the relay's `threadKey`), when it belongs to one. */
  readonly conversationId?: string;
}

/** The MCP server's name in the CLI: its tools read `mcp__gemies__<tool>` in Claude Code. */
export const GEMIE_TOOLS_SERVER = 'gemies';

const CREDENTIAL_ENV = 'GEMIES_AGENT_CREDENTIAL';
const CONVERSATION_ENV = 'GEMIES_CONVERSATION';
/** The header Gemies reads the run's conversation from (`EXTERNAL_AGENT_CONVERSATION_HEADER`). */
export const CONVERSATION_HEADER = 'X-Gemies-Conversation';

export function gemieToolsUrl(apiBaseUrl: string, agentId: string): string {
  return `${apiBaseUrl}/mcp/agents/${encodeURIComponent(agentId)}`;
}

/** The person's environment, plus the credential (and conversation) the run's MCP config names. */
export function toolsEnv(tools: GemieTools, base: NodeJS.ProcessEnv = process.env) {
  const { [CONVERSATION_ENV]: _stale, ...rest } = base;
  return {
    ...rest,
    [CREDENTIAL_ENV]: tools.credential,
    ...(tools.conversationId ? { [CONVERSATION_ENV]: tools.conversationId } : {}),
  };
}

/**
 * Claude Code: the server for this run, and its tools allowed. `-p` cannot ask the person, so a tool
 * that is not allowed is refused; what the gemie may do is decided in Gemies, by its grants and the
 * governance every call goes through, not again here.
 */
export function claudeToolArgs(tools: GemieTools): string[] {
  const config = {
    mcpServers: {
      [GEMIE_TOOLS_SERVER]: {
        type: 'http',
        url: tools.url,
        headers: {
          Authorization: `Bearer \${${CREDENTIAL_ENV}}`,
          ...(tools.conversationId ? { [CONVERSATION_HEADER]: `\${${CONVERSATION_ENV}}` } : {}),
        },
      },
    },
  };
  return ['--mcp-config', JSON.stringify(config), '--allowedTools', `mcp__${GEMIE_TOOLS_SERVER}`];
}

/** Codex: config overrides for this run; the bearer is read from the environment. */
export function codexToolArgs(tools: GemieTools): string[] {
  const key = `mcp_servers.${GEMIE_TOOLS_SERVER}`;
  return [
    '-c',
    `${key}.url=${JSON.stringify(tools.url)}`,
    '-c',
    `${key}.bearer_token_env_var=${JSON.stringify(CREDENTIAL_ENV)}`,
    ...(tools.conversationId
      ? ['-c', `${key}.env_http_headers={ "${CONVERSATION_HEADER}" = "${CONVERSATION_ENV}" }`]
      : []),
  ];
}

/**
 * OpenCode: `OPENCODE_CONFIG_CONTENT`, merged into whatever the person already put there, with the
 * header read from the environment (`{env:…}`).
 */
export function opencodeToolsEnv(tools: GemieTools, base: NodeJS.ProcessEnv = process.env) {
  let current: { mcp?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(base.OPENCODE_CONFIG_CONTENT ?? '{}');
    if (parsed !== null && typeof parsed === 'object') current = parsed as typeof current;
  } catch {
    // Not JSON: OpenCode would not read it either.
  }
  const config = {
    ...current,
    mcp: {
      ...current.mcp,
      [GEMIE_TOOLS_SERVER]: {
        type: 'remote',
        url: tools.url,
        headers: {
          Authorization: `Bearer {env:${CREDENTIAL_ENV}}`,
          ...(tools.conversationId ? { [CONVERSATION_HEADER]: `{env:${CONVERSATION_ENV}}` } : {}),
        },
      },
    },
  };
  return { ...toolsEnv(tools, base), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
