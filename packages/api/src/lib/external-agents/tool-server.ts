/**
 * An external agent's tools, served to its CLI as an MCP server (ADR 0039).
 *
 * The tools are the ones its gemie would get on any turn: `ToolPipeline.forUser`, the one assembler,
 * with the gemie's grants, for its owner. Nothing here picks tools. The lane says only what it is:
 *
 *  - it acts for the owner (`actsForPerson`), who paired the agent and granted what it reaches;
 *  - it has no Oxy session (`isDirectSession: false`, no bearer, no task), so nothing that needs the
 *    person's own Oxy authority — their apps (`oxy_*`), automations, agent creation — is built;
 *  - it reserved no credits (`isLocalRuntime: true`: an external turn costs nothing, ADR 0030 §3),
 *    so nothing that runs hosted inference behind a tool call is built either;
 *  - the gemie has no Oxy account (ADR 0036), so no memory of Gemies' (`forUser` builds none).
 *
 * Every call runs here, in Gemies, under the same governance a gemie's actions get
 * (`lib/agent/governance.ts`): R3 and a blocking threat never run, R2 is flagged, and each call is
 * recorded (`external_agent_tool_calls`). The CLI only calls; nothing runs on the person's machine.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import { asSchema, type Tool, type ToolSet } from 'ai';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { recordExternalToolCall } from '../../db/agents/externalAgentRepository.js';
import type { ExternalToolCallOutcome } from '../../domain/external-agent.js';
import { classifyActionRisk } from '../agent/governance.js';
import { analyzeThreat, formatThreatSummary } from '../agent/threat-detector.js';
import { isDeclaredReadOnly, isOxyAppTool } from '../agent/tool-effects.js';
import { attachAgentIdentity } from '../agent-identity.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { LOAD_TOOLS_TOOL } from '../tool-budget.js';

/** Whose tools: the external agent, and the person it belongs to (its link's owner). */
export interface ExternalAgentToolScope {
  readonly agentId: string;
  readonly ownerOxyUserId: string;
}

/** The agent's tools for its owner, from the one assembler; empty when the agent is gone. */
export async function externalAgentTools(scope: ExternalAgentToolScope): Promise<ToolSet> {
  const record = await findAgentById(getDb(), scope.agentId);
  // Its link names its owner, and so does its row (ADR 0036): two that disagree serve nothing.
  if (record === null || record.ownerOxyAccountId !== scope.ownerOxyUserId) {
    return {};
  }
  const agent = await attachAgentIdentity(record);
  // Imported when used, as `runAgentTurn` does: the pipeline imports half the API.
  const { ToolPipeline } = await import('../tool-pipeline.js');
  const { tools } = await ToolPipeline.forUser({
    userId: scope.ownerOxyUserId,
    requesterAccountId: scope.ownerOxyUserId,
    isDirectSession: false,
    actsForPerson: true,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: true,
    agent,
    requestId: randomUUID(),
  });
  // The loader exists for a model limited to 128 tools per request; an MCP client lists them all.
  const { [LOAD_TOOLS_TOOL]: _loader, ...served } = tools;
  return served;
}

/** A tool as MCP lists it: its JSON Schema, always an object. */
async function listed(name: string, tool: Tool): Promise<McpTool> {
  const schema = (await asSchema(tool.inputSchema).jsonSchema) as Record<string, unknown>;
  return {
    name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: { ...schema, type: 'object' },
  };
}

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Runs one call under the governance of a gemie's actions and records it. Never throws: a failure is
 * an error result the agent reads, as a failed tool is for a gemie.
 */
export async function callExternalAgentTool(input: {
  scope: ExternalAgentToolScope;
  tools: ToolSet;
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<CallToolResult> {
  const { scope, tools, name, args, signal } = input;
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
  if (tool?.execute === undefined) return textResult(`Unknown tool: ${name}`, true);

  const startedAt = Date.now();
  const risk = classifyActionRisk(name, args, {
    declaredReadOnly: isDeclaredReadOnly(tool),
    // Nobody watches this lane from Gemies: the person is at the CLI, if anywhere.
    attended: false,
    oxyApp: isOxyAppTool(tool),
  });
  const threat = analyzeThreat(name, args);
  const { agentId, ownerOxyUserId } = scope;
  const record = (outcome: ExternalToolCallOutcome) =>
    recordExternalToolCall(getDb(), {
      id: randomUUID(),
      agentId,
      ownerOxyUserId,
      toolName: name,
      riskLevel: risk.riskLevel,
      outcome,
      durationMs: Date.now() - startedAt,
    }).catch((err: unknown) =>
      log.agents.error(
        { err, agentId, toolName: name },
        'Could not record an external agent tool call',
      ),
    );

  // Limits, not approvals (ADR 0020 §3): R3 and a blocking threat never run.
  if (risk.riskLevel === 'R3' || threat.shouldBlock) {
    const reason = risk.riskLevel === 'R3' ? risk.reason : formatThreatSummary(threat);
    log.agents.warn(
      { agentId, toolName: name, risk: risk.riskLevel, reason },
      'External agent tool call blocked',
    );
    await record('blocked');
    return textResult(`Blocked by policy: ${reason}`, true);
  }
  if (risk.riskLevel === 'R2' || threat.shouldFlag) {
    log.agents.info(
      {
        agentId,
        toolName: name,
        risk: risk.riskLevel,
        reason: risk.reason,
        threat: formatThreatSummary(threat),
      },
      'External agent tool call flagged',
    );
  }

  const validated = await asSchema(tool.inputSchema).validate?.(args);
  if (validated && !validated.success) {
    await record('error');
    return textResult(`Invalid arguments for ${name}: ${getErrorMessage(validated.error)}`, true);
  }
  try {
    const result: unknown = await tool.execute(validated ? validated.value : args, {
      toolCallId: randomUUID(),
      messages: [],
      abortSignal: signal,
    });
    await record('ok');
    return textResult(typeof result === 'string' ? result : JSON.stringify(result ?? null));
  } catch (err: unknown) {
    log.agents.warn({ err, agentId, toolName: name }, 'External agent tool call failed');
    await record('error');
    return textResult(`${name} failed: ${getErrorMessage(err).slice(0, 500)}`, true);
  }
}

/**
 * Answers one MCP request (Streamable HTTP, stateless, JSON responses) for an authenticated external
 * agent. The tools are assembled once per request, when the request first needs them.
 */
export async function serveExternalAgentTools(
  scope: ExternalAgentToolScope,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
): Promise<void> {
  let assembled: Promise<ToolSet> | undefined;
  const served = () => {
    assembled ??= externalAgentTools(scope);
    return assembled;
  };

  const server = new Server(
    { name: 'gemies', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        "The tools of this gemie in Gemies, as its owner granted them. They run in Gemies on the owner's behalf; what each one reaches is the owner's.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await served();
    return {
      tools: await Promise.all(Object.entries(tools).map(([name, tool]) => listed(name, tool))),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) =>
    callExternalAgentTool({
      scope,
      tools: await served(),
      name: call.params.name,
      args: call.params.arguments ?? {},
      signal: extra.signal,
    }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
