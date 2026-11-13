import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index.js';
import { externalAgentLinks, externalAgentPairings } from '../schema/external-agents.js';
import type { ExternalAgentCli } from '../../domain/external-agent.js';

export async function createPairing(
  db: ApiDatabase,
  input: {
    id: string;
    codeHash: string;
    ownerOxyUserId: string;
    expiresAt: Date;
    /** The agent a reconnect code is for; omitted for a new connection. */
    agentId?: string;
  },
): Promise<void> {
  await db.insert(externalAgentPairings).values(input);
}

/** Who minted a redeemed code, and the agent it reconnects (null: a new connection). */
export interface RedeemedPairing {
  readonly ownerOxyUserId: string;
  readonly agentId: string | null;
}

/**
 * Consumes a code in ONE conditional UPDATE, so two daemons racing for the same code cannot both
 * win, and answers whose it was: the code is the authorisation (ADR 0038), so its row, not the
 * caller, says which account the redemption acts for. `null` for an unknown, used or expired code.
 */
export async function redeemPairing(
  db: Executor,
  input: { codeHash: string; now: Date },
): Promise<RedeemedPairing | null> {
  const [row] = await db
    .update(externalAgentPairings)
    .set({ redeemedAt: input.now })
    .where(
      and(
        eq(externalAgentPairings.codeHash, input.codeHash),
        isNull(externalAgentPairings.redeemedAt),
        gt(externalAgentPairings.expiresAt, input.now),
      ),
    )
    .returning({
      ownerOxyUserId: externalAgentPairings.ownerOxyUserId,
      agentId: externalAgentPairings.agentId,
    });
  return row ?? null;
}

interface ExternalLinkMachine {
  agentId: string;
  ownerOxyUserId: string;
  cli: ExternalAgentCli;
  hostName: string;
  /** SHA-256 of the credential the daemon will present. */
  credentialHash: string;
}

export async function createExternalLink(db: Executor, input: ExternalLinkMachine): Promise<void> {
  await db.insert(externalAgentLinks).values(input);
}

/**
 * Points a live link of this owner at the machine that redeemed a reconnect code: its CLI, its
 * computer and its new credential. The previous credential stops opening the relay at once.
 * Returns false when the link is gone or not the owner's (revoked since the code was minted).
 */
export async function replaceExternalLinkCredential(
  db: Executor,
  input: ExternalLinkMachine,
): Promise<boolean> {
  const rows = await db
    .update(externalAgentLinks)
    .set({ cli: input.cli, hostName: input.hostName, credentialHash: input.credentialHash })
    .where(
      and(
        eq(externalAgentLinks.agentId, input.agentId),
        eq(externalAgentLinks.ownerOxyUserId, input.ownerOxyUserId),
        isNull(externalAgentLinks.revokedAt),
      ),
    )
    .returning({ agentId: externalAgentLinks.agentId });
  return rows.length > 0;
}

/** The live link of an agent, or `undefined` when it is an ordinary agent or was revoked. */
export async function findExternalLink(db: ApiDatabase, agentId: string) {
  const [row] = await db
    .select()
    .from(externalAgentLinks)
    .where(and(eq(externalAgentLinks.agentId, agentId), isNull(externalAgentLinks.revokedAt)))
    .limit(1);
  return row;
}

/** Whether `agentId` has a live link: the question every agent turn asks, so it reads one column. */
export async function hasExternalLink(db: ApiDatabase, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ agentId: externalAgentLinks.agentId })
    .from(externalAgentLinks)
    .where(and(eq(externalAgentLinks.agentId, agentId), isNull(externalAgentLinks.revokedAt)))
    .limit(1);
  return rows.length > 0;
}

export async function listExternalLinks(db: ApiDatabase, ownerOxyUserId: string) {
  return db
    .select()
    .from(externalAgentLinks)
    .where(
      and(
        eq(externalAgentLinks.ownerOxyUserId, ownerOxyUserId),
        isNull(externalAgentLinks.revokedAt),
      ),
    )
    .orderBy(desc(externalAgentLinks.createdAt));
}

export async function markExternalLinkConnected(db: ApiDatabase, agentId: string): Promise<void> {
  await db
    .update(externalAgentLinks)
    .set({ lastConnectedAt: new Date() })
    .where(eq(externalAgentLinks.agentId, agentId));
}

/** Returns true when a live link of this owner was revoked. */
export async function revokeExternalLink(
  db: ApiDatabase,
  ownerOxyUserId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await db
    .update(externalAgentLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(externalAgentLinks.agentId, agentId),
        eq(externalAgentLinks.ownerOxyUserId, ownerOxyUserId),
        isNull(externalAgentLinks.revokedAt),
      ),
    )
    .returning({ agentId: externalAgentLinks.agentId });
  return rows.length > 0;
}
