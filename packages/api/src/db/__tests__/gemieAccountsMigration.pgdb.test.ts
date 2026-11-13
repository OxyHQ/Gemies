import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';

/**
 * ADR 0035: 0141 gives `connected_accounts` a gemie and 0142 backfills it, deleting Gmail and
 * Signal. This database was migrated from empty, so 0142's data statements are REPLAYED over rows
 * shaped like production's before the cut, inside a transaction that loosens what 0142 tightened
 * (it has to, to write the old shape at all) and is rolled back, so the suite's database ends as the
 * migrations left it. ADR 0035's amendment then makes each account its person's: 0156 and 0157's
 * backfills are replayed the same way, across the window the image being replaced still drains in.
 */

const BACKFILL = fileURLToPath(
  new URL('../../../drizzle/0142_gemie_accounts_without_gmail_or_signal.sql', import.meta.url),
);
const STATUSES = fileURLToPath(
  new URL('../../../drizzle/0146_gemie_account_status_vocabulary.sql', import.meta.url),
);
const GRANTS_PRE = fileURLToPath(
  new URL('../../../drizzle/0156_connected_account_grants.sql', import.meta.url),
);
const GRANTS_POST = fileURLToPath(
  new URL('../../../drizzle/0157_accounts_belong_to_their_person.sql', import.meta.url),
);

let db: ApiDatabase;

class Rollback extends Error {}

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/** A migration's data statements: its inserts, deletes and updates, without its DDL. */
function dataStatements(file = BACKFILL): string[] {
  return readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^--.*$/gm, '').trim())
    .filter((statement) => /^(INSERT|DELETE|UPDATE)\b/.test(statement));
}

describe('0142: every connected account names its gemie', () => {
  it('replays the delete and the backfill exactly as production would see them', async () => {
    expect(dataStatements()).toHaveLength(2);
    let observed: Record<string, string | null> | null = null;
    try {
      await db.transaction(async (tx) => {
        // The shape before the cut (0157 has since dropped `agent_id` again).
        await tx.execute(sql`alter table connected_accounts add column agent_id text`);
        await tx.execute(
          sql`alter table connected_accounts drop constraint connected_accounts_platform_check`,
        );
        await tx.execute(sql`alter table connected_accounts add column auto_reply_agent_id text`);
        const gemie = (id: string, owner: string | null, access: string, status = 'active') =>
          tx.execute(sql`
            insert into agents (id, oxy_account_id, character, tagline, description, author_oxy_user_id, category, owner_oxy_account_id, access, status)
            values (${id}, ${`bot-${id}`}, '{"preset":"blue_beret"}'::jsonb, 't', 'd', 'author', 'general', ${owner}, ${access}, ${status})`);
        await gemie('mig-own', 'mig-person', 'private');
        await gemie('mig-stranger', 'someone-else', 'private');
        await gemie('mig-public', 'someone-else', 'public');
        const account = (id: string, platform: string, autoReplyAgentId: string | null) =>
          tx.execute(sql`
            insert into connected_accounts (id, oxy_user_id, platform, auto_reply_agent_id)
            values (${id}, 'mig-person', ${platform}, ${autoReplyAgentId})`);
        await account('mig-none', 'whatsapp', null);
        await account('mig-own-row', 'telegram', 'mig-own');
        await account('mig-public-row', 'whatsapp', 'mig-public');
        await account('mig-stranger-row', 'whatsapp', 'mig-stranger');
        await account('mig-dangling', 'telegram', 'no-such-gemie');
        await account('mig-gmail', 'gmail', 'mig-own');
        await account('mig-signal', 'signal', null);

        for (const statement of dataStatements()) await tx.execute(sql.raw(statement));

        const rows = await tx.execute<{ id: string; agent_id: string | null }>(
          sql`select id, agent_id from connected_accounts where id like 'mig-%' order by id`,
        );
        observed = Object.fromEntries(rows.map((row) => [row.id, row.agent_id]));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(observed).toEqual({
      // Nobody named one: Alia, who answered every account until now.
      'mig-none': ALIA_GEMIE_ID,
      // The person's own gemie, and a public active one: kept.
      'mig-own-row': 'mig-own',
      'mig-public-row': 'mig-public',
      // Somebody else's private gemie, or one that no longer exists: Alia.
      'mig-stranger-row': ALIA_GEMIE_ID,
      'mig-dangling': ALIA_GEMIE_ID,
      // Gmail and Signal are gone.
    });
  });

  it('0146 rewrites the old statuses into the gateway’s vocabulary', async () => {
    expect(dataStatements(STATUSES)).toHaveLength(2);
    let observed: Record<string, string> | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`alter table connected_accounts drop constraint connected_accounts_status_check`,
        );
        for (const [id, status] of [
          ['st-connecting', 'connecting'],
          ['st-error', 'error'],
          ['st-expired', 'expired'],
          ['st-connected', 'connected'],
        ]) {
          await tx.execute(sql`
            insert into connected_accounts (id, oxy_user_id, platform, status)
            values (${id}, 'st-person', 'whatsapp', ${status})`);
        }
        for (const statement of dataStatements(STATUSES)) await tx.execute(sql.raw(statement));
        const rows = await tx.execute<{ id: string; status: string }>(
          sql`select id, status from connected_accounts where id like 'st-%' order by id`,
        );
        observed = Object.fromEntries(rows.map((row) => [row.id, row.status]));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(observed).toEqual({
      'st-connected': 'connected',
      'st-connecting': 'qr-pending',
      'st-error': 'failed',
      'st-expired': 'failed',
    });
  });

  it('0156 and 0157 make every account its person’s, granted to its gemie, which answers it', async () => {
    expect(dataStatements(GRANTS_PRE)).toHaveLength(1);
    expect(dataStatements(GRANTS_POST)).toHaveLength(2);
    let observed: { grants: string[]; capabilities: string[] } | null = null;
    try {
      await db.transaction(async (tx) => {
        // The shape the image being replaced writes until it drains.
        await tx.execute(sql`alter table connected_accounts add column agent_id text`);
        const gemie = (id: string, grants: string[]) =>
          tx.execute(sql`
            insert into agents (id, oxy_account_id, character, tagline, description, author_oxy_user_id, category, capability_grants)
            values (${id}, ${`bot-${id}`}, '{"preset":"blue_beret"}'::jsonb, 't', 'd', 'author', 'general', ${sql.param(grants)}::text[])`);
        await gemie('grm-one', ['web', 'messaging', 'agent']);
        await gemie('grm-two', ['messaging']);
        const account = (id: string, agentId: string | null) =>
          tx.execute(sql`
            insert into connected_accounts (id, oxy_user_id, platform, agent_id)
            values (${id}, 'grm-person', 'whatsapp', ${agentId})`);

        // Linked by the old image before the pre half ran.
        await account('grm-before', 'grm-one');
        for (const statement of dataStatements(GRANTS_PRE)) await tx.execute(sql.raw(statement));
        // While it drains: the old image links another, and the new image's person makes another
        // gemie answer the first (and links one that names no gemie).
        await account('grm-draining', 'grm-two');
        await account('grm-new', null);
        await tx.execute(
          sql`update connected_account_grants set answers = false where account_id = 'grm-before'`,
        );
        await tx.execute(sql`
          insert into connected_account_grants (account_id, agent_id, answers)
          values ('grm-before', 'grm-two', true)`);
        for (const statement of dataStatements(GRANTS_POST)) await tx.execute(sql.raw(statement));

        const grants = await tx.execute<{ account_id: string; agent_id: string; answers: boolean }>(
          sql`select account_id, agent_id, answers from connected_account_grants
              where account_id like 'grm-%' order by account_id, agent_id`,
        );
        const capabilities = await tx.execute<{ id: string; capability_grants: string[] }>(
          sql`select id, capability_grants from agents where id like 'grm-%' order by id`,
        );
        observed = {
          grants: grants.map((g) => `${g.account_id} ${g.agent_id} ${g.answers}`),
          capabilities: capabilities.map((a) => `${a.id} ${a.capability_grants.join(',')}`),
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(observed).toEqual({
      grants: [
        // The person's later choice is kept; the gemie it belonged to keeps its grant.
        'grm-before grm-one false',
        'grm-before grm-two true',
        // Linked while the old image drained: granted to its gemie, which answers it.
        'grm-draining grm-two true',
      ],
      // `messaging` is retired; nothing else changes.
      capabilities: ['grm-one web,agent', 'grm-two '],
    });
  });

  it('leaves accounts with no gemie of their own, and only WhatsApp and Telegram', async () => {
    const [column] = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
          where table_name = 'connected_accounts' and column_name = 'agent_id'`,
    );
    expect(column).toBeUndefined();
    const [answering] = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'connected_account_grants_one_answering_idx'`,
    );
    expect(answering?.indexdef).toContain('UNIQUE');
    expect(answering?.indexdef).toContain('WHERE answers');
    const dropped = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
          where table_name = 'connected_accounts'
            and column_name in ('auto_reply', 'auto_reply_agent_id', 'email', 'oauth_access_token')`,
    );
    expect(dropped).toEqual([]);
    const [source] = await db.execute<{ convalidated: boolean; def: string }>(
      sql`select convalidated, pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'conversations_source_check'`,
    );
    expect(source?.convalidated).toBe(true);
    expect(source?.def).not.toContain('signal');
  });
});
