import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { gemieBotTurns } from '../schema/bots';
import { messages } from '../schema/chat';
import { notifications } from '../schema/notifications';

/**
 * Migrations 0170–0174 over a conversation shaped like the gemie bot Telegram chat production held
 * on 2026-11-14: its channel prompt stored as the first message, every message stamped with the
 * instant a rewrite reinserted it, and a retried message stored three times with a reply per copy.
 *
 * The suite's database is already migrated, so the index and the CHECK these migrations create
 * exist. The whole replay runs in ONE transaction that is rolled back: it drops them, plants the
 * rows they now refuse, runs the five files in order, and asserts, leaving the shared database
 * exactly as it found it.
 */

const file = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../drizzle/${name}.sql`, import.meta.url)), 'utf8');

/** A migration's statements, as the migrator runs them. */
const statements = (name: string) =>
  file(name)
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^--.*$/gm, '').trim())
    .filter((statement) => statement !== '');

const USER = `cleanup-${process.pid}`;
const BOT = '8988966019';
const CHAT = '570038640';
const CONV = `telegram:${BOT}:${CHAT}`;
const FLAT = new Date('2026-11-14T09:15:32.470Z');
/** A UUIDv7 a client drew at 2026-11-13T17:10:33.414Z. */
const V7 = '01a1d5e3-b8c6-7bf7-adf7-9e0e06342205';

class Rollback extends Error {}

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

describe('0170–0174: what the saver’s rewrites left in a channel conversation', () => {
  it('drops the system prompt and the extra copies, restores real times, and renumbers', async () => {
    const outcome = await db
      .transaction(async (tx) => {
        await tx.execute(
          sql.raw('DROP INDEX IF EXISTS "messages_oxy_user_conversation_client_message_key"'),
        );
        // The CHECK as it stood before 0173, which admitted `system`.
        await tx.execute(
          sql.raw('ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_role_check"'),
        );
        await tx.execute(
          sql.raw(
            `ALTER TABLE "messages" ADD CONSTRAINT "messages_role_check" CHECK ("role" in ('user', 'assistant', 'system'))`,
          ),
        );

        const row = (
          seq: number,
          clientMessageId: string,
          role: string,
          content: unknown,
          createdAt = FLAT,
        ) => ({
          oxyUserId: USER,
          conversationId: CONV,
          clientMessageId,
          // A role the schema no longer admits is exactly what is being planted.
          role: role as 'user',
          content,
          seq,
          createdAt,
        });
        await tx.insert(messages).values([
          row(0, 'msg-0', 'system', 'The user is chatting via telegram. Be concise and friendly.'),
          row(1, V7, 'user', 'Hey'),
          row(2, `telegram:${CHAT}:22`, 'user', [{ type: 'text', text: 'y ahora?' }]),
          row(3, 'first-reply', 'assistant', 'the first answer'),
          row(4, `telegram:${CHAT}:22`, 'user', [{ type: 'text', text: 'y ahora?' }]),
          row(5, 'second-reply', 'assistant', 'another answer'),
          row(6, 'agent-push-canva', 'assistant', 'Heads-up about a billing issue'),
          row(7, `telegram:${CHAT}:33`, 'user', [{ type: 'text', text: '[Sticker]' }]),
          row(8, 'sticker-reply', 'assistant', 'Jaja, entendido'),
          // Written after the rewrite, at its own time: untouched.
          row(9, `telegram:${CHAT}:53`, 'user', 'Salúdame', new Date('2026-11-14T09:19:42.666Z')),
        ]);
        // A second chat whose every flattened message is recoverable: each gets its time back.
        const OTHER = `telegram:${BOT}:42`;
        await tx.insert(messages).values(
          [
            [0, 'telegram:42:1', 'user', 'Hola'],
            [1, 'hola-reply', 'assistant', '¡Hola!'],
            [2, 'telegram:42:3', 'user', '¿Qué tal?'],
          ].map(([seq, id, role, content]) => ({
            ...row(seq as number, id as string, role as string, content),
            conversationId: OTHER,
          })),
        );
        await tx.insert(gemieBotTurns).values([
          {
            botId: BOT,
            chatId: '42',
            messageId: '1',
            status: 'answered',
            answer: { reply: '¡Hola!' },
            createdAt: new Date('2026-11-13T10:00:00.000Z'),
            updatedAt: new Date('2026-11-13T10:00:02.000Z'),
          },
          {
            botId: BOT,
            chatId: '42',
            messageId: '3',
            status: 'answered',
            answer: { reply: null },
            createdAt: new Date('2026-11-13T10:05:00.000Z'),
            updatedAt: new Date('2026-11-13T10:05:01.000Z'),
          },
        ]);
        await tx.insert(gemieBotTurns).values({
          botId: BOT,
          chatId: CHAT,
          messageId: '33',
          status: 'answered',
          answer: { reply: 'Jaja, entendido' },
          createdAt: new Date('2026-11-14T01:52:10.300Z'),
          updatedAt: new Date('2026-11-14T01:52:14.444Z'),
        });
        await tx.insert(notifications).values({
          oxyUserId: USER,
          type: 'proactive_insight',
          title: 'Eusebio',
          body: 'Heads-up',
          conversationId: CONV,
          data: { messageId: 'agent-push-canva' },
          createdAt: new Date('2026-11-14T01:34:43.647Z'),
        });

        for (const name of [
          '0170_messages_duplicates_removed',
          '0171_messages_stored_once',
          '0172_messages_without_system',
          '0173_messages_role_check',
          '0174_messages_role_check_validate',
        ]) {
          for (const statement of statements(name)) await tx.execute(sql.raw(statement));
        }

        const rows = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.oxyUserId, USER), eq(messages.conversationId, CONV)))
          .orderBy(messages.seq);
        const other = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.oxyUserId, USER), eq(messages.conversationId, OTHER)))
          .orderBy(messages.seq);
        // Each refused write in its own savepoint, so the transaction carries on to the assertions.
        const refused = (value: typeof messages.$inferInsert) =>
          tx
            .transaction((savepoint) => savepoint.insert(messages).values(value))
            .then(
              () => false,
              () => true,
            );
        const systemRefused = await refused(row(99, 'again', 'system', 'You are Eusebio.'));
        const copyRefused = await refused(row(98, `telegram:${CHAT}:22`, 'user', 'y ahora?'));
        throw Object.assign(new Rollback(), { rows, other, systemRefused, copyRefused });
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) return error as Rollback & Record<string, unknown>;
        throw error;
      });

    const rows = outcome.rows as Array<typeof messages.$inferSelect>;
    expect(rows.map((message) => [message.seq, message.clientMessageId])).toEqual([
      [0, V7],
      [1, `telegram:${CHAT}:22`],
      [2, 'first-reply'],
      [3, 'agent-push-canva'],
      [4, `telegram:${CHAT}:33`],
      [5, 'sticker-reply'],
      [6, `telegram:${CHAT}:53`],
    ]);
    const at = Object.fromEntries(
      rows.map((message) => [message.clientMessageId, message.createdAt.toISOString()]),
    );
    expect(at).toEqual({
      [V7]: '2026-11-13T17:10:33.414Z',
      // Nothing records when it was written: it keeps the instant it has.
      [`telegram:${CHAT}:22`]: FLAT.toISOString(),
      'first-reply': FLAT.toISOString(),
      // Recoverable, but after a message that kept the rewrite's instant: restored, it would come
      // before it on a thread page, which orders by time. It keeps that instant too.
      'agent-push-canva': FLAT.toISOString(),
      [`telegram:${CHAT}:33`]: FLAT.toISOString(),
      'sticker-reply': FLAT.toISOString(),
      [`telegram:${CHAT}:53`]: '2026-11-14T09:19:42.666Z',
    });
    // So time order is the conversation's order.
    const times = rows.map((message) => message.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const other = outcome.other as Array<typeof messages.$inferSelect>;
    expect(other.map((message) => message.createdAt.toISOString())).toEqual([
      '2026-11-13T10:00:00.000Z',
      '2026-11-13T10:00:02.000Z',
      '2026-11-13T10:05:00.000Z',
    ]);
    expect(outcome.systemRefused).toBe(true);
    expect(outcome.copyRefused).toBe(true);
  });
});

describe('0175: a run’s status line delivered as its message', () => {
  it('becomes the typed failure, and nothing else does', async () => {
    const outcome = await db
      .transaction(async (tx) => {
        const conversationId = `run-status-${process.pid}`;
        const message = (seq: number, clientMessageId: string, content: string) => ({
          oxyUserId: USER,
          conversationId,
          clientMessageId,
          role: 'assistant' as const,
          content,
          seq,
        });
        await tx
          .insert(messages)
          .values([
            message(0, 'agent-push-result-a', 'Token budget exhausted. Partial progress was made.'),
            message(1, 'agent-push-result-b', 'Tienes 20 emails sin leer.'),
            message(2, 'reply-c', 'Token budget exhausted. Partial progress was made.'),
          ]);
        for (const statement of statements('0175_run_status_lines_become_failures'))
          await tx.execute(sql.raw(statement));
        const rows = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.oxyUserId, USER), eq(messages.conversationId, conversationId)))
          .orderBy(messages.seq);
        throw Object.assign(new Rollback(), { rows });
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) return error as Rollback & Record<string, unknown>;
        throw error;
      });

    const rows = outcome.rows as Array<typeof messages.$inferSelect>;
    expect(rows.map((row) => row.content)).toEqual([
      [{ type: 'failure', code: 'task_unfinished' }],
      'Tienes 20 emails sin leer.',
      'Token budget exhausted. Partial progress was made.',
    ]);
  });
});
