/**
 * External agents (ADR 0030): pair a person's coding-agent CLI with Gemies so it appears as one of
 * their gemies.
 *
 *   POST   /agents/external/pair          the app mints a single-use code + the text to paste
 *   POST   /agents/external/redeem        the daemon trades the code for its agent's credential
 *   GET    /agents/external               the person's external agents, with live presence
 *   DELETE /agents/external/:agentId      revoke: the link dies and the daemon is cut off
 *
 * The code is the authorisation (ADR 0038). The signed-in person mints it, so it is bound to them on
 * our side; `redeem` takes no session at all, because the machine that runs it has none and must
 * not need one. Redeeming returns a credential for THAT agent only, which the daemon presents on
 * `/ws/external-agent` for as long as the agent exists.
 *
 * A paired agent has no Oxy account (ADR 0036): it is a `local` gemie, its name and colour kept on
 * its own row and its owner the person who paired it. A CLI added for a while is not an account.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { avatarCharacterFor } from '@oxy.so/contracts';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createAgent, deleteAgent, findAgentById } from '../../db/agents/agentRepository.js';
import {
  createExternalLink,
  createPairing,
  findExternalLink,
  listExternalLinks,
  redeemPairing,
  replaceExternalLinkCredential,
  revokeExternalLink,
} from '../../db/agents/externalAgentRepository.js';
import {
  EXTERNAL_AGENT_CLI_COLORS,
  EXTERNAL_AGENT_CLI_LABELS,
  EXTERNAL_AGENT_CLIS,
  EXTERNAL_PAIRING_TTL_MS,
  type ExternalAgentCli,
} from '../../domain/external-agent.js';
import { authenticateToken } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';
import { checkWindowLimit } from '../../lib/sliding-window-limiter.js';
import {
  generateExternalAgentCredential,
  hashExternalAgentCredential,
} from '../../lib/external-agents/credential.js';
import { buildInvitePrompt, inviteLocaleOf } from '../../lib/external-agents/invite-prompt.js';
import {
  generatePairingCode,
  hashPairingCode,
  isWellFormedPairingCode,
} from '../../lib/external-agents/pairing-code.js';
import {
  disconnectExternalAgent,
  isExternalAgentReachable,
} from '../../lib/external-agents/relay.js';
import { publishGemieChanged } from '../../lib/realtime/account.js';

const router = Router();
const route =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

const pairSchema = z
  .object({
    locale: z.string().max(35).optional(),
    /** Reconnect this external agent (a new machine, a lost credential) instead of adding one. */
    agentId: z.string().min(1).max(64).optional(),
  })
  .strict();

const redeemSchema = z
  .object({
    code: z.string().min(1).max(64),
    cli: z.enum(EXTERNAL_AGENT_CLIS),
    hostName: z.string().trim().min(1).max(80),
  })
  .strict();

/** Five codes a minute per account is far more than a person pairing machines needs. */
const PAIRINGS_PER_MINUTE = 5;
/**
 * Redemptions a minute per address, used or not. A person redeems one code per machine; the limit
 * is there for whoever tries codes, who with ~79 bits per code and a handful live gets nowhere anyway.
 */
const REDEMPTIONS_PER_MINUTE = 10;

async function rateLimited(res: Response, key: string, perMinute: number): Promise<boolean> {
  // A Redis outage degrades to a per-instance limit, never to none: `redeem` is unauthenticated.
  const limit = await checkWindowLimit(key, perMinute, { onUnavailable: 'local' });
  if (limit.allowed) return false;
  res.setHeader('Retry-After', String(limit.resetInSeconds ?? 60));
  res.status(429).json({ error: 'rate_limited' });
  return true;
}

router.post(
  '/external/pair',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = pairSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    const userId = req.user.id;
    const { agentId } = parsed.data;
    if (agentId !== undefined) {
      // Only a live external agent of the caller's can be reconnected; anything else is not found.
      const link = await findExternalLink(getDb(), agentId);
      if (link === undefined || link.ownerOxyUserId !== userId) {
        return res.status(404).json({ error: 'Not found' });
      }
    }
    if (await rateLimited(res, `rl:external-pair:${userId}`, PAIRINGS_PER_MINUTE)) return;

    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + EXTERNAL_PAIRING_TTL_MS);
    await createPairing(getDb(), {
      id: randomUUID(),
      codeHash: hashPairingCode(code),
      ownerOxyUserId: userId,
      expiresAt,
      ...(agentId === undefined ? {} : { agentId }),
    });
    res.status(201).json({
      code,
      expiresAt: expiresAt.toISOString(),
      prompt: buildInvitePrompt({ code, locale: inviteLocaleOf(parsed.data.locale) }),
    });
  }),
);

/** What a redemption made: the agent the daemon now serves, and the credential it connects with. */
interface Redemption {
  readonly ownerOxyUserId: string;
  readonly agentId: string;
  readonly name: string;
  readonly reconnected: boolean;
}

/**
 * Consumes the code and makes its agent in ONE transaction: a failure after the code is consumed
 * rolls it back, so the person's code still works rather than being burnt on our error.
 */
async function redeem(input: {
  codeHash: string;
  cli: ExternalAgentCli;
  hostName: string;
  credentialHash: string;
}): Promise<Redemption | null> {
  const { cli, hostName, credentialHash } = input;
  return getDb().transaction(async (tx) => {
    const pairing = await redeemPairing(tx, { codeHash: input.codeHash, now: new Date() });
    if (pairing === null) return null;
    const { ownerOxyUserId } = pairing;

    if (pairing.agentId !== null) {
      const machine = { agentId: pairing.agentId, ownerOxyUserId, cli, hostName, credentialHash };
      // Revoked since the code was minted: the code reconnects nothing.
      if (!(await replaceExternalLinkCredential(tx, machine))) return null;
      const agent = await findAgentById(tx, pairing.agentId);
      const name =
        agent?.identity.source === 'local'
          ? agent.identity.name
          : `${EXTERNAL_AGENT_CLI_LABELS[cli]} · ${hostName}`;
      return { ownerOxyUserId, agentId: pairing.agentId, name, reconnected: true };
    }

    const label = EXTERNAL_AGENT_CLI_LABELS[cli];
    const name = `${label} · ${hostName}`;
    const agent = await createAgent(tx, {
      identity: { source: 'local', name, color: EXTERNAL_AGENT_CLI_COLORS[cli] },
      // Picked from its name, so the agents of two computers look apart; its owner changes it.
      character: avatarCharacterFor(name),
      ownerOxyAccountId: ownerOxyUserId,
      tagline: `${label} on ${hostName}`,
      description: `${label} running on ${hostName}, connected to Gemies through the Codea daemon.`,
      authorOxyUserId: ownerOxyUserId,
      category: 'Assistant',
      isPublished: false,
      access: 'private',
    });
    await createExternalLink(tx, {
      agentId: agent._id,
      ownerOxyUserId,
      cli,
      hostName,
      credentialHash,
    });
    return { ownerOxyUserId, agentId: agent._id, name, reconnected: false };
  });
}

router.post(
  '/external/redeem',
  route(async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (await rateLimited(res, `rl:external-redeem:${ip}`, REDEMPTIONS_PER_MINUTE)) {
      log.general.warn({ ip }, 'External agent redemption rate limited');
      return;
    }
    const parsed = redeemSchema.safeParse(req.body);
    if (!parsed.success || !isWellFormedPairingCode(parsed.data.code)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const { cli, hostName } = parsed.data;
    const credential = generateExternalAgentCredential();
    const credentialHash = hashExternalAgentCredential(credential);

    const redemption = await redeem({
      codeHash: hashPairingCode(parsed.data.code),
      cli,
      hostName,
      credentialHash,
    });
    if (redemption === null) {
      log.general.warn({ ip, cli }, 'External agent code refused: unknown, used or expired');
      return res.status(400).json({ error: 'invalid_or_expired_code' });
    }

    const { agentId, name, ownerOxyUserId, reconnected } = redemption;
    // The machine that held the previous credential is cut off now, not when it next reconnects.
    if (reconnected) {
      disconnectExternalAgent(agentId, { reason: 'credential-replaced', credentialHash });
    }
    log.general.info(
      { agentId, cli, hostName, userId: ownerOxyUserId, ip, reconnected },
      reconnected ? 'External agent reconnected' : 'External agent paired',
    );
    // The owner's gemies list shows it on every device (`gemies`, `docs/realtime.mdx`).
    void publishGemieChanged(ownerOxyUserId, agentId, reconnected ? 'updated' : 'created');
    res.status(201).json({ agentId, name, cli, credential });
  }),
);

router.get(
  '/external',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const links = await listExternalLinks(getDb(), req.user.id);
    const agents = await Promise.all(
      links.map(async (link) => ({
        agentId: link.agentId,
        cli: link.cli,
        hostName: link.hostName,
        online: await isExternalAgentReachable(link.agentId),
        createdAt: link.createdAt,
        lastConnectedAt: link.lastConnectedAt,
      })),
    );
    res.json({ agents });
  }),
);

router.delete(
  '/external/:agentId',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const agentId = String(req.params.agentId);
    const revoked = await revokeExternalLink(getDb(), req.user.id, agentId);
    if (!revoked) return res.status(404).json({ error: 'Not found' });
    disconnectExternalAgent(agentId, { reason: 'revoked' });
    // The agent goes too: without its link it would answer as an ordinary agent, with Alia's model.
    // It has no Oxy account to leave behind (ADR 0036).
    await deleteAgent(getDb(), agentId).catch((err: unknown) => {
      log.general.error({ err, agentId }, 'Could not delete the agent of a revoked external link');
    });
    void publishGemieChanged(req.user.id, agentId, 'deleted');
    res.status(204).end();
  }),
);

export default router;
