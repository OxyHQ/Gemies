import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_PROMPT_TOOL,
  startApprovalServer,
  type ApprovalQuestion,
  type ApprovalServer,
} from '../approval-server.js';

let server: ApprovalServer;
beforeEach(async () => {
  server = await startApprovalServer();
});
afterEach(() => server.close());

const rpc = (url: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });

const call = (input: object, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'approve', arguments: { tool_name: 'Bash', input, tool_use_id: 'tu_1' } },
});

const verdictOf = async (response: Response) => {
  const body = (await response.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
};

describe('approval server', () => {
  it('names its tool the way Claude Code names an MCP permission prompt tool', () => {
    expect(APPROVAL_PROMPT_TOOL).toBe('mcp__gemies_approval__approve');
  });

  it('speaks enough MCP for a client to connect: initialize, then the one tool', async () => {
    const run = server.register(async () => 'allow');
    const init = await rpc(run.url, run.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude' } },
    });
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
    });
    const note = await rpc(run.url, run.token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(note.status).toBe(202);
    const list = await rpc(run.url, run.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(['approve']);
    const unknown = await rpc(run.url, run.token, { jsonrpc: '2.0', id: 3, method: 'nope' });
    expect(await unknown.json()).toMatchObject({ error: { code: -32601 } });
  });

  it('asks the handler what the CLI wants, and answers allow with the same input', async () => {
    const asked: ApprovalQuestion[] = [];
    const run = server.register(async (q) => {
      asked.push(q);
      return 'allow';
    });
    const verdict = await verdictOf(await rpc(run.url, run.token, call({ command: 'bun test' })));
    expect(asked).toEqual([{ tool: 'Bash', summary: 'bun test' }]);
    expect(verdict).toEqual({ behavior: 'allow', updatedInput: { command: 'bun test' } });
  });

  it('answers deny when the person denies, when the handler fails, and when the question is empty', async () => {
    const denies = server.register(async () => 'deny');
    expect(
      (await verdictOf(await rpc(denies.url, denies.token, call({ command: 'rm -rf /' }))))
        .behavior,
    ).toBe('deny');

    const throws = server.register(async () => {
      throw new Error('socket gone');
    });
    expect((await verdictOf(await rpc(throws.url, throws.token, call({})))).behavior).toBe('deny');

    let asked = false;
    const empty = server.register(async () => {
      asked = true;
      return 'allow';
    });
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'approve', arguments: { input: {} } },
    };
    expect((await verdictOf(await rpc(empty.url, empty.token, body))).behavior).toBe('deny');
    expect(asked).toBe(false);
  });

  it('holds the answer until the person decides', async () => {
    let decide!: (d: 'allow' | 'deny') => void;
    const run = server.register(() => new Promise((resolve) => (decide = resolve)));
    const pending = rpc(run.url, run.token, call({ command: 'ls' }));
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 80));
    expect(settled).toBe(false);
    decide('allow');
    expect((await verdictOf(await pending)).behavior).toBe('allow');
  });

  it('is closed to anything without the run’s token, on the run’s own path, and after it ends', async () => {
    const run = server.register(async () => 'allow');
    const other = server.register(async () => 'allow');
    expect((await rpc(run.url, 'wrong-token', call({}))).status).toBe(404);
    expect((await rpc(run.url, other.token, call({}))).status).toBe(404);
    expect((await fetch(run.url, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(
      (
        await fetch(run.url.replace(/approve\/.*/, 'approve/zzzzzzzzzzzzzzzzzz'), {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(run.url, { headers: { authorization: `Bearer ${run.token}` } })).status,
    ).toBe(405);
    run.dispose();
    expect((await rpc(run.url, run.token, call({}))).status).toBe(404);
  });

  it('refuses a body that is not JSON-RPC', async () => {
    const run = server.register(async () => 'allow');
    const bad = await fetch(run.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${run.token}` },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
  });

  it('listens on the loopback only', async () => {
    const run = server.register(async () => 'allow');
    expect(new URL(run.url).hostname).toBe('127.0.0.1');
  });
});
