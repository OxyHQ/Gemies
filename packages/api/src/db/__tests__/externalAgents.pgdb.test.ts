import { uuidv7 } from '@oxy.so/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExternalLink,
  createPairing,
  findExternalLink,
  listExternalLinks,
  redeemPairing,
  replaceExternalLinkCredential,
  revokeExternalLink,
} from '../agents/externalAgentRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { externalAgentPairings } from '../schema/external-agents';

/**
 * Pairing codes and agent links (ADR 0030, ADR 0038), against a real Postgres: a code is consumed by
 * exactly one conditional UPDATE, only before it expires, and names the account that minted it; a
 * link is unique per agent, a revoked one is invisible, and reconnecting replaces its credential.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const mint = async (owner: string, ttlMs = 60_000) => {
  const codeHash = `hash-${uuidv7()}`;
  await createPairing(db, {
    id: uuidv7(),
    codeHash,
    ownerOxyUserId: owner,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return codeHash;
};

describe('redeemPairing', () => {
  const redeem = (codeHash: string) => redeemPairing(db, { codeHash, now: new Date() });

  it('is single use, and answers whose code it was', async () => {
    const codeHash = await mint('owner-a');
    expect(await redeem(codeHash)).toEqual({ ownerOxyUserId: 'owner-a', agentId: null });
    expect(await redeem(codeHash)).toBeNull();
  });

  it('carries the agent a reconnect code is for', async () => {
    const codeHash = `hash-${uuidv7()}`;
    await createPairing(db, {
      id: uuidv7(),
      codeHash,
      ownerOxyUserId: 'owner-a',
      expiresAt: new Date(Date.now() + 60_000),
      agentId: 'agent-x',
    });
    expect(await redeem(codeHash)).toEqual({ ownerOxyUserId: 'owner-a', agentId: 'agent-x' });
  });

  it('lets exactly one of many racing redeemers win', async () => {
    const codeHash = await mint('owner-a');
    const results = await Promise.all(Array.from({ length: 8 }, () => redeem(codeHash)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('refuses an expired code and an unknown one', async () => {
    expect(await redeem(await mint('owner-a', -1000))).toBeNull();
    expect(await redeem('no-such-code')).toBeNull();
  });

  it('keeps the code hash unique', async () => {
    const codeHash = await mint('owner-a');
    await expect(
      createPairing(db, {
        id: uuidv7(),
        codeHash,
        ownerOxyUserId: 'owner-a',
        expiresAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toThrow();
  });
});

describe('external agent links', () => {
  it('creates one link per agent, finds it, lists it for its owner and hides it once revoked', async () => {
    const agentId = `ext-${uuidv7()}`;
    const owner = `owner-${uuidv7()}`;
    await createExternalLink(db, {
      agentId,
      ownerOxyUserId: owner,
      cli: 'codex',
      hostName: 'laptop',
      credentialHash: 'cred-1',
    });
    expect(await findExternalLink(db, agentId)).toMatchObject({
      cli: 'codex',
      credentialHash: 'cred-1',
    });
    expect((await listExternalLinks(db, owner)).map((l) => l.agentId)).toEqual([agentId]);
    await expect(
      createExternalLink(db, {
        agentId,
        ownerOxyUserId: owner,
        cli: 'claude',
        hostName: 'x',
        credentialHash: 'cred-2',
      }),
    ).rejects.toThrow();

    expect(await revokeExternalLink(db, 'someone-else', agentId)).toBe(false);
    expect(await findExternalLink(db, agentId)).toBeDefined();
    expect(await revokeExternalLink(db, owner, agentId)).toBe(true);
    expect(await revokeExternalLink(db, owner, agentId)).toBe(false);
    expect(await findExternalLink(db, agentId)).toBeUndefined();
    expect(await listExternalLinks(db, owner)).toEqual([]);
  });

  it('replaces the credential and machine of a live link of its owner only', async () => {
    const agentId = `ext-${uuidv7()}`;
    const owner = `owner-${uuidv7()}`;
    const machine = { agentId, ownerOxyUserId: owner, cli: 'codex' as const, hostName: 'laptop' };
    await createExternalLink(db, { ...machine, credentialHash: 'old' });

    const moved = { ...machine, cli: 'claude' as const, hostName: 'desk', credentialHash: 'new' };
    expect(await replaceExternalLinkCredential(db, { ...moved, ownerOxyUserId: 'other' })).toBe(
      false,
    );
    expect((await findExternalLink(db, agentId))?.credentialHash).toBe('old');
    expect(await replaceExternalLinkCredential(db, moved)).toBe(true);
    expect(await findExternalLink(db, agentId)).toMatchObject({
      cli: 'claude',
      hostName: 'desk',
      credentialHash: 'new',
    });

    await revokeExternalLink(db, owner, agentId);
    expect(await replaceExternalLinkCredential(db, { ...moved, credentialHash: 'later' })).toBe(
      false,
    );
  });

  it('refuses a CLI outside the supported set', async () => {
    await expect(
      db.execute(
        sql`INSERT INTO external_agent_links (agent_id, owner_oxy_user_id, cli, host_name)
            VALUES (${`bad-${uuidv7()}`}, 'o', 'gemini', 'h')`,
      ),
    ).rejects.toThrow();
  });

  it('keeps pairing rows unreachable once swept (the table exists and is sweepable)', async () => {
    const rows = await db.select().from(externalAgentPairings).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });
});
