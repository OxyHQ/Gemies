/**
 * The permission prompt of a CLI, answered by the person in Gemies (Gemies ADR 0043 §5).
 *
 * `claude -p` cannot ask anyone, so a command it was not allowed to run is refused. With
 * `--permission-prompt-tool` it asks an MCP tool instead, and that tool is this: a server on this
 * computer's loopback, reachable only with a token made for the run, that turns each question into a
 * request to Gemies (over the WebSocket the daemon already holds, so no HTTP request waits minutes
 * behind a load balancer) and answers the CLI with what the person decided.
 *
 * This is the third-party CLI's own question to its own user about their own computer; it is not an
 * Oxy permission or consent. Nothing here widens what the CLI may do: an answer of "allow" only lets
 * it do what it asked, once, and anything unanswered, malformed or late is "deny".
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { claudeTarget } from './activity.js';

export type ApprovalDecision = 'allow' | 'deny';

export interface ApprovalQuestion {
  /** Claude Code's name for the tool it wants to use: `Bash`, `Edit`, `mcp__…`. */
  readonly tool: string;
  /** What it acts on, short: the command, the path. */
  readonly summary?: string;
}

/** What answers a question for one run: the person, through Gemies. */
export type ApprovalHandler = (question: ApprovalQuestion) => Promise<ApprovalDecision>;

/** The tool the CLI is told to ask, as Claude Code names an MCP tool: `mcp__<server>__<tool>`. */
export const APPROVAL_SERVER = 'gemies_approval';
export const APPROVAL_TOOL = 'approve';
export const APPROVAL_PROMPT_TOOL = `mcp__${APPROVAL_SERVER}__${APPROVAL_TOOL}`;
export const APPROVAL_TOKEN_ENV = 'GEMIES_APPROVAL_TOKEN';

/** What one run needs to reach its approval server. */
export interface RunApprovals {
  readonly url: string;
  readonly token: string;
}

export interface ApprovalServer {
  /** Registers the handler for one run; `dispose` ends it. */
  register(handler: ApprovalHandler): RunApprovals & { dispose(): void };
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

const toolDefinition = {
  name: APPROVAL_TOOL,
  description:
    'Asks the person whether Claude Code may use a tool. Not for the model to call: Claude Code calls it for permission prompts.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** What Claude Code reads back from a permission prompt tool: a JSON document as the tool's text. */
function verdict(decision: ApprovalDecision, input: unknown) {
  const body =
    decision === 'allow'
      ? { behavior: 'allow', updatedInput: input ?? {} }
      : { behavior: 'deny', message: 'The person did not allow this in Gemies.' };
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startApprovalServer(): Promise<ApprovalServer> {
  const runs = new Map<string, { token: string; handler: ApprovalHandler }>();

  const answer = async (
    run: { handler: ApprovalHandler },
    message: Record<string, unknown>,
  ): Promise<unknown | null> => {
    const id = message.id;
    const method = message.method;
    // A notification (no id): accepted, nothing to say.
    if (id === undefined) return null;
    if (method === 'initialize') {
      const params = (message.params ?? {}) as { protocolVersion?: unknown };
      return rpcResult(id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: APPROVAL_SERVER, version: '1.0.0' },
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: [toolDefinition] });
    if (method === 'tools/call') {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (params.name !== APPROVAL_TOOL) return rpcError(id, -32602, 'Unknown tool');
      const args = (params.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
      const tool =
        typeof args.tool_name === 'string' && args.tool_name !== '' ? args.tool_name : null;
      // A question that does not say what it is about is not one the person can answer.
      if (tool === null) return rpcResult(id, verdict('deny', args.input));
      const summary = claudeTarget(args.input);
      let decision: ApprovalDecision = 'deny';
      try {
        decision = await run.handler({ tool, ...(summary ? { summary } : {}) });
      } catch {
        decision = 'deny';
      }
      return rpcResult(id, verdict(decision, args.input));
    }
    return rpcError(id, -32601, 'Method not found');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const match = /^\/approve\/([A-Za-z0-9_-]{16,64})$/.exec(req.url ?? '');
    const run = match ? runs.get(match[1]) : undefined;
    const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!run || !sameToken(bearer, run.token)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw === null ? undefined : JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const replies = (
      await Promise.all(
        messages.map((m) =>
          m !== null && typeof m === 'object' ? answer(run, m as Record<string, unknown>) : null,
        ),
      )
    ).filter((r) => r !== null);
    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only, on a port the system picks: nothing off this computer can reach it.
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;

  return {
    register(handler) {
      const id = randomBytes(24).toString('base64url');
      const token = randomBytes(32).toString('base64url');
      runs.set(id, { token, handler });
      return {
        url: `http://127.0.0.1:${port}/approve/${id}`,
        token,
        dispose: () => {
          runs.delete(id);
        },
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
