import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';

/**
 * 0147: a gemie's colour is its account's, so the characters lose their paint — the agents' and the
 * messages' snapshot of who said them. This database was migrated from empty, so 0147's statements
 * are REPLAYED over rows shaped like production's before the cut, in a transaction that is rolled
 * back so the suite's database ends as the migrations left it.
 */

const MIGRATION = fileURLToPath(
  new URL('../../../drizzle/0147_gemie_characters_without_paint.sql', import.meta.url),
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

function statements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^--.*$/gm, '').trim())
    .filter((statement) => statement !== '');
}

describe('0147: characters without a paint', () => {
  it('removes the named and the free paint, and keeps every other part', async () => {
    expect(statements()).toHaveLength(2);
    const conversation = randomUUID();
    const before = {
      'paint-named': {
        shape: 'pebble',
        eyes: 'oval',
        eyewear: 'none',
        accessory: 'none',
        color: 'coral',
      },
      'paint-hex': {
        shape: 'star',
        eyes: 'dots',
        eyewear: 'none',
        accessory: 'none',
        bodyColor: '#ff90c0',
      },
      'paint-preset': { preset: 'blue_beret', accessory: 'none', color: 'orchid' },
      'paint-none': { shape: 'cloud', eyes: 'oval', eyewear: 'none', accessory: 'none' },
    };
    let agentsAfter: Record<string, unknown> = {};
    let messagesAfter: Record<string, unknown> = {};
    try {
      await db.transaction(async (tx) => {
        for (const [id, character] of Object.entries(before)) {
          await tx.execute(sql`
            insert into agents (id, oxy_account_id, character, tagline, description, author_oxy_user_id, category, access, status)
            values (${id}, ${`bot-${id}`}, ${JSON.stringify(character)}::jsonb, 't', 'd', 'author', 'general', 'private', 'active')`);
          await tx.execute(sql`
            insert into messages (id, conversation_id, oxy_user_id, client_message_id, role, content, agent_info_id, agent_info_name, agent_info_color, agent_info_character, agent_info_handle)
            values (${randomUUID()}, ${conversation}, 'person-0147', ${id}, 'assistant', '"hola"'::jsonb, ${id}, 'Gemie', 'mint', ${JSON.stringify(character)}::jsonb, 'gemie')`);
        }
        await tx.execute(sql`
          insert into messages (id, conversation_id, oxy_user_id, client_message_id, role, content)
          values (${randomUUID()}, ${conversation}, 'person-0147', 'no-agent', 'user', '"hola"'::jsonb)`);

        for (const statement of statements()) await tx.execute(sql.raw(statement));

        const agents = await tx.execute<{ id: string; character: unknown }>(
          sql`select id, character from agents where id like 'paint-%'`,
        );
        agentsAfter = Object.fromEntries(agents.map((row) => [row.id, row.character]));
        const messages = await tx.execute<{ id: string; character: unknown }>(
          sql`select client_message_id as id, agent_info_character as character from messages where conversation_id = ${conversation}`,
        );
        messagesAfter = Object.fromEntries(messages.map((row) => [row.id, row.character]));
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    const expected = {
      'paint-named': { shape: 'pebble', eyes: 'oval', eyewear: 'none', accessory: 'none' },
      'paint-hex': { shape: 'star', eyes: 'dots', eyewear: 'none', accessory: 'none' },
      'paint-preset': { preset: 'blue_beret', accessory: 'none' },
      'paint-none': before['paint-none'],
    };
    expect(agentsAfter).toEqual(expected);
    expect(messagesAfter).toEqual({ ...expected, 'no-agent': null });
  });
});
