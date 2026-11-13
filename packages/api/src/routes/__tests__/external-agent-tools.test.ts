/**
 * `/mcp/agents/:agentId` — an external agent's tools as a remote MCP server (ADR 0039), spoken to by
 * the MCP SDK's own client. The rules under test: only that agent's live credential opens it; the
 * tools are the assembler's, for the owner, on the external lane; every call is governed (R3 never
 * runs) and recorded; a failure is a tool error, never a broken transport.
 */
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tool, type ToolSet } from 'ai';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { hashExternalAgentCredential } from '../../lib/external-agents/credential.js';
import { resetLocalWindows } from '../../lib/sliding-window-limiter.js';

const CREDENTIAL = 'gxa_agent-1-credential';

const state = vi.hoisted(() => ({
  link: undefined as
    | { agentId: string; ownerOxyUserId: string; credentialHash: string | null }
    | undefined,
  agentOwner: 'owner-1',
  forUser: vi.fn(),
  record: vi.fn(),
  deleted: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/agents/externalAgentRepository.js', () => ({
  findExternalLink: async () => state.link,
  recordExternalToolCall: state.record,
}));
vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: async (_db: unknown, id: string) => ({
    _id: id,
    ownerOxyAccountId: state.agentOwner,
    identity: { source: 'local', name: 'Claude Code · desk', color: 'orange' },
  }),
}));
vi.mock('../../lib/agent-identity.js', () => ({
  attachAgentIdentity: async (row: unknown) => row,
}));
vi.mock('../../lib/tool-pipeline.js', () => ({ ToolPipeline: { forUser: state.forUser } }));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child, rateLimit: child } };
});

const { default: router } = await import('../external-agent-tools.js');

const tools: ToolSet = {
  getCurrentDate: tool({
    description: 'The date',
    inputSchema: z.object({}),
    execute: async () => ({ date: '2026-11-13' }),
  }),
  echo: tool({
    description: 'Echo a word',
    inputSchema: z.object({ word: z.string() }),
    execute: async ({ word }) => `echo ${word}`,
  }),
  delete_file: tool({
    description: 'Delete a file',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => state.deleted(),
  }),
  boom: tool({
    description: 'Fails',
    inputSchema: z.object({}),
    execute: async (): Promise<string> => {
      throw new Error('the connector is down');
    },
  }),
  loadTools: tool({ description: 'loader', inputSchema: z.object({}), execute: async () => '' }),
};

const app = express();
app.use(express.json());
app.use('/mcp/agents', router);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalWindows();
  state.agentOwner = 'owner-1';
  state.link = {
    agentId: 'agent-1',
    ownerOxyUserId: 'owner-1',
    credentialHash: hashExternalAgentCredential(CREDENTIAL),
  };
  state.forUser.mockResolvedValue({ tools });
  state.record.mockResolvedValue(undefined);
});

async function connect(credential = CREDENTIAL): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp/agents/agent-1`), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
    }),
  );
  return client;
}

const post = (credential?: string) =>
  fetch(`${base}/mcp/agents/agent-1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

describe('who opens it', () => {
  it('refuses no credential, another credential, an Oxy-session-era link and a revoked agent', async () => {
    expect((await post()).status).toBe(401);
    expect((await post('gxa_someone-else')).status).toBe(401);
    state.link = { agentId: 'agent-1', ownerOxyUserId: 'owner-1', credentialHash: null };
    expect((await post(CREDENTIAL)).status).toBe(401);
    state.link = undefined;
    const revoked = await post(CREDENTIAL);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('www-authenticate')).toContain('Bearer');
    expect(state.forUser).not.toHaveBeenCalled();
  });

  it('serves no stream: GET is 405', async () => {
    const response = await fetch(`${base}/mcp/agents/agent-1`, {
      headers: { authorization: `Bearer ${CREDENTIAL}`, accept: 'text/event-stream' },
    });
    expect(response.status).toBe(405);
  });
});

describe('its tools', () => {
  it('lists the assembler’s tools for the owner, on the external lane, without the loader', async () => {
    const client = await connect();
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name).sort()).toEqual([
      'boom',
      'delete_file',
      'echo',
      'getCurrentDate',
    ]);
    expect(listed.find((t) => t.name === 'echo')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { word: { type: 'string' } },
    });
    expect(state.forUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        requesterAccountId: 'owner-1',
        isDirectSession: false,
        actsForPerson: true,
        isLocalRuntime: true,
      }),
    );
    expect(state.forUser.mock.calls[0][0]).not.toHaveProperty('accessToken');
    await client.close();
  });

  it('serves nothing when the agent’s row and its link disagree on the owner', async () => {
    state.agentOwner = 'someone-else';
    const client = await connect();
    expect((await client.listTools()).tools).toEqual([]);
    expect(state.forUser).not.toHaveBeenCalled();
    await client.close();
  });

  it('runs a call in Gemies and records it', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'echo', arguments: { word: 'hola' } });
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo hola' }] });
    expect(state.record).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentId: 'agent-1',
        ownerOxyUserId: 'owner-1',
        toolName: 'echo',
        outcome: 'ok',
      }),
    );
    await client.close();
  });

  it('never runs what the governance blocks (R3), and records that it did not', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'delete_file', arguments: { path: 'a.txt' } });
    expect(result.isError).toBe(true);
    expect(state.deleted).not.toHaveBeenCalled();
    expect(state.record).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ toolName: 'delete_file', riskLevel: 'R3', outcome: 'blocked' }),
    );
    await client.close();
  });

  it('answers a failure, bad arguments and an unknown tool as tool errors', async () => {
    const client = await connect();
    const failed = await client.callTool({ name: 'boom', arguments: {} });
    expect(failed).toMatchObject({ isError: true });
    expect(JSON.stringify(failed.content)).toContain('the connector is down');
    expect(state.record).toHaveBeenCalledWith({}, expect.objectContaining({ outcome: 'error' }));

    const invalid = await client.callTool({ name: 'echo', arguments: { word: 3 } });
    expect(invalid).toMatchObject({ isError: true });
    const unknown = await client.callTool({ name: 'loadTools', arguments: {} });
    expect(unknown).toMatchObject({ isError: true });
    await client.close();
  });
});
