/**
 * The per-account event log behind the realtime socket (`docs/realtime.mdx`).
 *
 * Every durable change a client shows — a conversation's row and its new messages, a reaction, the
 * person's gemies, credits, notifications, connections — is appended here AFTER its own write
 * commits and pushed to the account's sockets with its number. A client remembers the last number
 * it applied; after a reconnect it asks for what came after it, so nothing is lost and nothing is
 * refetched wholesale.
 *
 * ## Why a per-account counter row, and not a sequence
 *
 * A global `bigserial` is allocated at INSERT and visible at COMMIT, so two concurrent writers can
 * commit 101 before 100: a client that saw 101 and asks for `> 101` never sees 100. The head row
 * is updated in the SAME statement that inserts the event, so its row lock serialises one
 * account's appends and the numbers commit in order, with no gaps. Nothing else is ever held in
 * that transaction (the event is written after the change it describes commits), so the lock is
 * statement-long and cannot take part in a deadlock.
 *
 * ## Retention
 *
 * Three days (`ACCOUNT_EVENT_RETENTION_SECONDS`, swept by `db/expiryTargets.ts`). The head row is
 * kept forever — it is one row per account — so a number is never reused after the events behind
 * it were swept.
 */

import { bigint, check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId } from '@oxy.so/db';
import { ACCOUNT_EVENT_TYPES } from '../../domain/account-events.js';
import { checkOneOf } from './columns';

/** The newest event number of each account. */
export const accountEventHeads = pgTable(
  'account_event_heads',
  {
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().primaryKey(),
    seq: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [check('account_event_heads_seq_check', sql`${t.seq} > 0`)],
);

/** One durable change, numbered within its account. */
export const accountEvents = pgTable(
  'account_events',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** 1, 2, 3… within the account, in commit order. */
    seq: bigint({ mode: 'number' }).notNull(),
    type: text({ enum: ACCOUNT_EVENT_TYPES as unknown as [string, ...string[]] }).notNull(),
    /** The event's body, as clients receive it (`lib/realtime/contract.ts`). */
    data: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Catch-up reads `seq > cursor` for one account, in order.
    uniqueIndex('account_events_oxy_user_seq_key').on(t.oxyUserId, t.seq),
    // The retention sweep.
    index('account_events_created_at_idx').on(t.createdAt),
    checkOneOf('account_events_type_check', t.type, ACCOUNT_EVENT_TYPES),
  ],
);
