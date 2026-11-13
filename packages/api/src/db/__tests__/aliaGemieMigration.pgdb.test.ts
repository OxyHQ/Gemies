import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALIA_GEMIE_CONFIGURATION } from '../../__tests__/support/gemies';
import { ALIA_GEMIE_ID, ALIA_PENDING_OXY_ACCOUNT_ID } from '../../domain/alia-gemie';
import { findAgentById, listAgentCatalogue, searchActiveAgents } from '../agents/agentRepository';
import { findAutomationDefinitionById } from '../automation/automationDefinitionRepository';
import {
  isEmailAlertEnabled,
  listEmailAlertPreferences,
} from '../proactive/emailOutreachRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';

/**
 * ADR 0034 §2: Alia is an `agents` row (0134 adds the configuration, 0135 seeds her and rewrites the
 * `null`s that spelled her, 0136 rewrites what the replaced image wrote during the rollout, and
 * 0137–0139 make `conversations.agent_id` NOT NULL).
 *
 * This database was migrated from empty, so the seed is read back as it landed, and the rewrite is
 * REPLAYED over rows shaped like production's from before the cut. The replay runs inside a
 * transaction that loosens what 0139 tightened (it has to, to write the old `null`s at all) and is
 * rolled back, so the suite's database ends as the migrations left it.
 */

const REWRITE = fileURLToPath(
  new URL('../../../drizzle/0136_alia_gemie_rewrite_window.sql', import.meta.url),
);
const SEED = fileURLToPath(new URL('../../../drizzle/0135_alia_gemie.sql', import.meta.url));

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

function statements(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .filter((statement) => statement.replace(/--.*$/gm, '').trim() !== '');
}

describe('0135: Alia is one official, global gemie', () => {
  it('is seeded by id, configured as Alia, and holds no machine', async () => {
    const alia = await findAgentById(db, ALIA_GEMIE_ID);
    expect(alia).not.toBeNull();
    expect(alia).toMatchObject({
      ...ALIA_GEMIE_CONFIGURATION,
      capabilityGrants: [...ALIA_GEMIE_CONFIGURATION.capabilityGrants],
      identity: { source: 'oxy', oxyAccountId: ALIA_PENDING_OXY_ACCOUNT_ID },
      ownerOxyAccountId: null,
      systemPrompt: null,
      featureGates: {},
      primaryTools: [],
    });
    expect(alia?.capabilityGrants).not.toContain('computer');
    expect(alia?.capabilityGrants).not.toContain('browser');
  });

  it('keeps every other gemie an ordinary one: the defaults are a persona’s', async () => {
    const [column] = await db.execute<{
      memory_store: string;
      reach: string;
      mailbox: string;
      task_authority: string;
    }>(
      sql`select
        (select column_default from information_schema.columns where table_name = 'agents' and column_name = 'memory_store') as memory_store,
        (select column_default from information_schema.columns where table_name = 'agents' and column_name = 'reach') as reach,
        (select column_default from information_schema.columns where table_name = 'agents' and column_name = 'mailbox') as mailbox,
        (select column_default from information_schema.columns where table_name = 'agents' and column_name = 'task_authority') as task_authority`,
    );
    expect(column).toEqual({
      memory_store: "'gemie'::text",
      reach: "'grants'::text",
      mailbox: 'true',
      task_authority: "'session'::text",
    });
  });

  it('is not listed while her Oxy account is pending: no catalogue card, no search hit', async () => {
    const { agents: listed } = await listAgentCatalogue(db, { limit: 500, offset: 0 });
    expect(listed.map((agent) => agent.id)).not.toContain(ALIA_GEMIE_ID);
    for (const query of ['assistant', 'Oxy', 'everybody', 'Nilo']) {
      const found = await searchActiveAgents(db, query, 50);
      expect(found.map((agent) => agent.id)).not.toContain(ALIA_GEMIE_ID);
    }
    // Still public and active: everybody's default gemie, reachable with no Oxy round trip.
    expect(await findAgentById(db, ALIA_GEMIE_ID)).toMatchObject({
      access: 'public',
      status: 'active',
    });
  });

  it('is seeded only once: replaying the seed changes nothing', async () => {
    const before = await findAgentById(db, ALIA_GEMIE_ID);
    for (const statement of statements(SEED).filter((s) => /insert into "agents"/i.test(s))) {
      await db.execute(sql.raw(statement));
    }
    expect(await findAgentById(db, ALIA_GEMIE_ID)).toEqual(before);
  });
});

describe('0139: every conversation belongs to a gemie', () => {
  it('refuses a conversation that names none', async () => {
    await expect(
      db.execute(
        sql`insert into conversations (id, oxy_user_id, conversation_id) values (${randomUUID()}, 'person-0139', ${randomUUID()})`,
      ),
    ).rejects.toThrow();
  });
});

describe('0136: the rows that spelled Alia as null now name her gemie', () => {
  it('rewrites conversations, calls, system bots, feedback on her replies and her tasks — and nothing else', async () => {
    const person = `person-${randomUUID()}`;
    const alias = {
      aliaChat: randomUUID(),
      agentChat: randomUUID(),
      group: randomUUID(),
      aliaCall: randomUUID(),
      agentCall: randomUUID(),
      systemBot: randomUUID(),
      userBot: randomUUID(),
      aliaTask: randomUUID(),
      agentTask: randomUUID(),
      aliaRun: randomUUID(),
      mailbox: randomUUID(),
      agentRun: randomUUID(),
      reply: randomUUID(),
      question: randomUUID(),
    };
    let observed: Record<string, unknown> = {};
    try {
      await db.transaction(async (tx) => {
        // The shape before the cut: what 0139 forbids and what 0135/0136 rewrite.
        await tx.execute(sql`alter table conversations alter column agent_id drop not null`);
        await tx.execute(
          sql`alter table automation_definitions drop constraint automation_definitions_actor_mode_check`,
        );
        await tx.execute(sql`insert into conversations (id, oxy_user_id, conversation_id, agent_id) values
          (${randomUUID()}, ${person}, ${alias.aliaChat}, null),
          (${randomUUID()}, ${person}, ${alias.agentChat}, 'sindi'),
          (${randomUUID()}, ${person}, ${alias.group}, null)`);
        await tx.execute(sql`insert into messages (id, conversation_id, oxy_user_id, client_message_id, role, content) values
          (${randomUUID()}, ${alias.aliaChat}, ${person}, ${alias.question}, 'user', '"hola"'::jsonb),
          (${randomUUID()}, ${alias.aliaChat}, ${person}, ${alias.reply}, 'assistant', '"hola, soy Alia"'::jsonb)`);
        await tx.execute(sql`insert into message_reaction_states (id, oxy_user_id, conversation_id, message_id, target_actor_id, reactions) values
          (${randomUUID()}, ${person}, ${alias.aliaChat}, ${alias.reply}, null, '["👍"]'::jsonb),
          (${randomUUID()}, ${person}, ${alias.aliaChat}, ${alias.question}, null, '["👀"]'::jsonb)`);
        await tx.execute(sql`insert into voice_calls (id, oxy_user_id, conversation_id, agent_id, holder_task, status, lease_expires_at, ended_at, end_reason) values
          (${alias.aliaCall}, ${person}, ${alias.aliaChat}, null, 'task', 'ended', now(), now(), 'hangup'),
          (${alias.agentCall}, ${person}, ${alias.agentChat}, 'sindi', 'task', 'ended', now(), now(), 'hangup')`);
        await tx.execute(sql`insert into bots (id, platform, bot_id, name, user_id, agent_id) values
          (${alias.systemBot}, 'telegram', ${randomUUID()}, 'Alia', null, null),
          (${alias.userBot}, 'telegram', ${randomUUID()}, 'Unbound', ${person}, null)`);
        await tx.execute(sql`insert into automation_definitions (id, owner_account_id, objective, trigger_kind, actor_mode, fixed_agent_id, maximum_autonomy) values
          (${alias.aliaTask}, ${person}, 'news', 'manual', 'alia', null, 'autonomous'),
          (${alias.agentTask}, ${person}, 'homes', 'manual', 'fixed', 'sindi', 'autonomous')`);
        await tx.execute(sql`insert into automation_runs (id, automation_id, requester_account_id, selected_actor_type, selected_agent_id, idempotency_key, status, started_at) values
          (${alias.aliaRun}, ${alias.aliaTask}, ${person}, 'alia', null, ${randomUUID()}, 'planned', now()),
          (${alias.agentRun}, ${alias.agentTask}, ${person}, 'agent', 'sindi', ${randomUUID()}, 'planned', now())`);

        await tx.execute(
          sql`alter table email_alert_preferences alter column agent_id drop not null`,
        );
        await tx.execute(
          sql`alter table email_outreach_decisions alter column agent_id drop not null`,
        );
        await tx.execute(
          sql`insert into email_alert_preferences (oxy_user_id, agent_id, enabled) values (${person}, null, false)`,
        );
        await tx.execute(sql`insert into email_outreach_decisions (id, mailbox_account_id, message_id, oxy_user_id, agent_id, verdict) values
          (${randomUUID()}, ${person}, ${alias.mailbox}, ${person}, null, 'important')`);

        // The rollout window: the image that runs reads the pre-cut spellings as Alia's gemie.
        const window = {
          task: (await findAutomationDefinitionById(tx, alias.aliaTask))?.actorSelection,
          alerts: await isEmailAlertEnabled(tx, person, ALIA_GEMIE_ID),
          switches: await listEmailAlertPreferences(tx, person),
        };

        for (const statement of statements(REWRITE)) await tx.execute(sql.raw(statement));

        const rows = async (query: ReturnType<typeof sql>) =>
          Object.fromEntries(
            (await tx.execute<{ k: string; v: string | null }>(query)).map((row) => [row.k, row.v]),
          );
        observed = {
          window,
          alerts: await rows(
            sql`select 'switch' as k, agent_id as v from email_alert_preferences where oxy_user_id = ${person}`,
          ),
          decisions: await rows(
            sql`select message_id as k, agent_id as v from email_outreach_decisions where oxy_user_id = ${person}`,
          ),
          conversations: await rows(
            sql`select conversation_id as k, agent_id as v from conversations where oxy_user_id = ${person}`,
          ),
          calls: await rows(
            sql`select id as k, agent_id as v from voice_calls where oxy_user_id = ${person}`,
          ),
          bots: await rows(
            sql`select id as k, agent_id as v from bots where id in (${alias.systemBot}, ${alias.userBot})`,
          ),
          feedback: await rows(
            sql`select message_id as k, target_actor_id as v from message_reaction_states where oxy_user_id = ${person}`,
          ),
          runs: await rows(
            sql`select id as k, selected_agent_id as v from automation_runs where requester_account_id = ${person}`,
          ),
          tasks: await rows(
            sql`select id as k, actor_mode || ':' || coalesce(fixed_agent_id, '') as v from automation_definitions where owner_account_id = ${person}`,
          ),
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(observed).toEqual({
      window: {
        task: { mode: 'fixed', agentId: ALIA_GEMIE_ID },
        alerts: false,
        switches: new Map([[ALIA_GEMIE_ID, false]]),
      },
      alerts: { switch: ALIA_GEMIE_ID },
      decisions: { [alias.mailbox]: ALIA_GEMIE_ID },
      conversations: {
        [alias.aliaChat]: ALIA_GEMIE_ID,
        [alias.agentChat]: 'sindi',
        // A room belongs to her gemie; its speakers are its members.
        [alias.group]: ALIA_GEMIE_ID,
      },
      calls: { [alias.aliaCall]: ALIA_GEMIE_ID, [alias.agentCall]: 'sindi' },
      // A user's bot nobody was bound to stays unbound: it never was Alia's.
      bots: { [alias.systemBot]: ALIA_GEMIE_ID, [alias.userBot]: null },
      // Only the feedback on HER reply; the person's own message has no actor.
      feedback: { [alias.reply]: ALIA_GEMIE_ID, [alias.question]: null },
      tasks: { [alias.aliaTask]: `fixed:${ALIA_GEMIE_ID}`, [alias.agentTask]: 'fixed:sindi' },
      // A run queued on the standing lane before the cut is still driven: it names her gemie.
      runs: { [alias.aliaRun]: ALIA_GEMIE_ID, [alias.agentRun]: 'sindi' },
    });
  });
});
