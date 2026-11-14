/**
 * `/mcp/agents/:agentId` — an external agent's tools, as a remote MCP server (ADR 0039).
 *
 * The daemon (`codea connect`) hands this address to the CLI it drives, with the agent's own
 * credential (ADR 0038) as the bearer. That credential is the only thing that opens it: no Oxy
 * session, no other agent's credential. Revoking the agent revokes its link, which is what is read
 * here on every request, so its tools close with it.
 *
 * Stateless Streamable HTTP with JSON responses: every request is a POST that authenticates on its
 * own; there is no session to resume and no server-sent stream (GET answers 405).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getDb } from '../db/index.js';
import { findExternalLink } from '../db/agents/externalAgentRepository.js';
import { EXTERNAL_TOOL_REQUESTS_PER_MINUTE } from '../domain/external-agent.js';
import { externalAgentCredentialMatches } from '../lib/external-agents/credential.js';
import {
  EXTERNAL_AGENT_CONVERSATION_HEADER,
  serveExternalAgentTools,
} from '../lib/external-agents/tool-server.js';
import { log } from '../lib/logger.js';
import { checkWindowLimit } from '../lib/sliding-window-limiter.js';

const router = Router();

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function bearerOf(req: Request): string | undefined {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/**
 * Requests a minute per address, before anything is read: this lane is exempt from Oxy's global
 * limiter (its bearer is not an Oxy token), so this is what bounds whoever is not an agent.
 */
const REQUESTS_PER_ADDRESS_PER_MINUTE = 600;

async function rateLimited(res: Response, key: string, perMinute: number): Promise<boolean> {
  const limit = await checkWindowLimit(key, perMinute, { onUnavailable: 'local' });
  if (limit.allowed) return false;
  res.setHeader('Retry-After', String(limit.resetInSeconds ?? 60));
  jsonRpcError(res, 429, -32000, 'Too many requests');
  return true;
}

router.all('/:agentId', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    const address = `rl:external-agent-tools:ip:${req.ip ?? 'unknown'}`;
    if (await rateLimited(res, address, REQUESTS_PER_ADDRESS_PER_MINUTE)) return;
    const agentId = String(req.params.agentId);
    const link = await findExternalLink(getDb(), agentId);
    // One answer for an unknown agent, a revoked one and a wrong credential: nothing to tell apart.
    if (
      link === undefined ||
      link.credentialHash === null ||
      !externalAgentCredentialMatches(bearerOf(req), link.credentialHash)
    ) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="gemies"');
      return jsonRpcError(res, 401, -32001, 'Unauthorized');
    }

    const perAgent = `rl:external-agent-tools:agent:${agentId}`;
    if (await rateLimited(res, perAgent, EXTERNAL_TOOL_REQUESTS_PER_MINUTE)) {
      log.agents.warn({ agentId }, 'External agent tool requests rate limited');
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return jsonRpcError(res, 405, -32000, 'Method not allowed');
    }
    // The conversation the run belongs to, which the daemon names; the tool server checks it.
    const conversation = req.headers[EXTERNAL_AGENT_CONVERSATION_HEADER];
    await serveExternalAgentTools(
      {
        agentId,
        ownerOxyUserId: link.ownerOxyUserId,
        ...(typeof conversation === 'string' && conversation !== ''
          ? { conversationId: conversation.slice(0, 128) }
          : {}),
      },
      req,
      res,
      req.body,
    );
  })().catch(next);
});

export default router;
