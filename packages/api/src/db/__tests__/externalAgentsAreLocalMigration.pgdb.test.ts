import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { createAgent, findAgentById, updateAgent } from '../agents/agentRepository';

/**
 * ADR 0036: an external agent has no Oxy account. 0149 turns the live ones `local`, and the CHECKs
 * 0148 added (0150 validates them) hold every row to its identity. This database was migrated from
 * empty, so 0149's statement is REPLAYED over rows shaped like production's before the cut, in a
 * transaction that is rolled back so the suite's database ends as the migrations left it.
 */

const MIGRATION = fileURLToPath(
  new URL('../../../drizzle/0149_external_agents_are_local.sql', import.meta.url),
);

let db: ApiDatabase;

class Rollback extends Error {}

const CHARACTER = { shape: 'bot_blob', eyes: 'bot', eyewear: 'none', accessory: 'none' };

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

function statements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^--.*$/gm, '').trim())
    .filter((statement) => statement !== '');
}

type Row = Record<string, unknown>;

describe('0149: external agents are local gemies', () => {
  it('moves a live external agent’s identity onto its row and leaves every other gemie alone', async () => {
    expect(statements()).toHaveLength(1);
    const owner = `owner-${randomUUID()}`;
    const ids = {
      claude: randomUUID(),
      codex: randomUUID(),
      revoked: randomUUID(),
      plain: randomUUID(),
    };
    let after: Record<string, Row> = {};
    try {
      await db.transaction(async (tx) => {
        for (const [key, id] of Object.entries(ids)) {
          await tx.execute(sql`
            insert into agents (id, oxy_account_id, owner_oxy_account_id, character, tagline, description, author_oxy_user_id, category, access, status, is_published, mailbox)
            values (${id}, ${`bot-${id}`}, ${owner}, ${JSON.stringify(CHARACTER)}::jsonb, 't', 'd', ${owner}, 'Assistant', 'private', 'active', ${key === 'plain'}, true)`);
        }
        const link = (agentId: string, cli: string, revoked: boolean) =>
          tx.execute(sql`
            insert into external_agent_links (agent_id, owner_oxy_user_id, cli, host_name, revoked_at)
            values (${agentId}, ${owner}, ${cli}, 'SuperPC', ${revoked ? new Date().toISOString() : null}::timestamptz)`);
        await link(ids.claude, 'claude', false);
        await link(ids.codex, 'codex', false);
        await link(ids.revoked, 'opencode', true);

        for (const statement of statements()) await tx.execute(sql.raw(statement));

        const rows = await tx.execute<Row>(sql`
          select id, identity, oxy_account_id, local_name, local_color, owner_oxy_account_id, is_published, access, mailbox, reach
          from agents where id in (${ids.claude}, ${ids.codex}, ${ids.revoked}, ${ids.plain})`);
        after = Object.fromEntries(rows.map((row) => [String(row.id), row]));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    const local = { identity: 'local', oxy_account_id: null, owner_oxy_account_id: owner };
    const unlisted = { is_published: false, access: 'private', mailbox: false, reach: 'grants' };
    expect(after[ids.claude]).toMatchObject({
      ...local,
      ...unlisted,
      local_name: 'Claude Code · SuperPC',
      local_color: 'orange',
    });
    expect(after[ids.codex]).toMatchObject({
      ...local,
      ...unlisted,
      local_name: 'Codex · SuperPC',
      local_color: 'graphite',
    });
    for (const untouched of [ids.revoked, ids.plain]) {
      expect(after[untouched]).toMatchObject({
        identity: 'oxy',
        oxy_account_id: `bot-${untouched}`,
        local_name: null,
        local_color: null,
      });
    }
  });
});

describe('a local gemie’s row', () => {
  it('is written and read back as its own identity, with no mailbox', async () => {
    const owner = `owner-${randomUUID()}`;
    const created = await createAgent(db, {
      identity: { source: 'local', name: 'Codex · laptop', color: 'graphite' },
      ownerOxyAccountId: owner,
      character: CHARACTER,
      tagline: 'Codex on laptop',
      description: 'd',
      authorOxyUserId: owner,
      category: 'Assistant',
      isPublished: false,
      access: 'private',
    });
    expect(created.identity).toEqual({
      source: 'local',
      name: 'Codex · laptop',
      color: 'graphite',
    });
    expect(created.mailbox).toBe(false);

    const renamed = await updateAgent(db, created._id, {
      localName: 'Laptop',
      localColor: '#ff8b67',
    });
    expect(renamed?.identity).toEqual({ source: 'local', name: 'Laptop', color: '#ff8b67' });
    expect((await findAgentById(db, created._id))?.identity).toEqual(renamed?.identity);
  });

  it.each([
    ['listed', { isPublished: true }],
    ['public', { access: 'public' as const }],
  ])('cannot be %s: the database refuses it', async (_label, patch) => {
    const owner = `owner-${randomUUID()}`;
    const created = await createAgent(db, {
      identity: { source: 'local', name: 'OpenCode · box', color: 'teal' },
      ownerOxyAccountId: owner,
      character: CHARACTER,
      tagline: 't',
      description: 'd',
      authorOxyUserId: owner,
      category: 'Assistant',
      isPublished: false,
      access: 'private',
    });
    await expect(updateAgent(db, created._id, patch)).rejects.toThrow();
  });

  it('an Oxy gemie cannot keep a name of its own', async () => {
    const owner = `owner-${randomUUID()}`;
    const created = await createAgent(db, {
      identity: { source: 'oxy', oxyAccountId: `bot-${randomUUID()}` },
      ownerOxyAccountId: owner,
      character: CHARACTER,
      tagline: 't',
      description: 'd',
      authorOxyUserId: owner,
      category: 'Assistant',
    });
    await expect(updateAgent(db, created._id, { localName: 'Shadow' })).rejects.toThrow();
  });
});
