/**
 * The two tables behind "tell me about important emails" (`db/schema/proactive.ts`).
 *
 * Owned by `lib/proactive/email-outreach.ts` and the settings route; nothing
 * else reads or writes them.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie.js';
import type { Executor } from '../index.js';
import {
  emailAlertPreferences,
  emailOutreachDecisions,
  type EmailOutreachVerdict,
} from '../schema/proactive.js';

/** No row is ON, for Alia and for an agent's own mailbox alike. */
export const EMAIL_ALERTS_DEFAULT = true;

/**
 * ROLLOUT WINDOW ONLY (ADR 0034): until migration 0136 (post, same release) rewrites them, a switch
 * set before the cut names Alia as `NULL`. Her gemie's own row wins over such a one. After 0136 no
 * `NULL` exists (0139 makes the column NOT NULL) and this reads only her id.
 */
function gemieIs(agentId: string) {
  return agentId === ALIA_GEMIE_ID
    ? or(eq(emailAlertPreferences.agentId, agentId), isNull(emailAlertPreferences.agentId))
    : eq(emailAlertPreferences.agentId, agentId);
}

/** Whether this person wants to hear about important email from this gemie (Alia's: their own Inbox). */
export async function isEmailAlertEnabled(
  db: Executor,
  oxyUserId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: emailAlertPreferences.enabled })
    .from(emailAlertPreferences)
    .where(and(eq(emailAlertPreferences.oxyUserId, oxyUserId), gemieIs(agentId)))
    .orderBy(sql`${emailAlertPreferences.agentId} nulls last`)
    .limit(1);
  return row?.enabled ?? EMAIL_ALERTS_DEFAULT;
}

/** Every switch this person has set, keyed by gemie id. Unset ones are absent. */
export async function listEmailAlertPreferences(
  db: Executor,
  oxyUserId: string,
): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ agentId: emailAlertPreferences.agentId, enabled: emailAlertPreferences.enabled })
    .from(emailAlertPreferences)
    .where(eq(emailAlertPreferences.oxyUserId, oxyUserId))
    // `nulls first`, so Alia's own row, read after, wins over a pre-cut NULL (see `gemieIs`).
    .orderBy(sql`${emailAlertPreferences.agentId} nulls first`);
  return new Map(rows.map((row) => [row.agentId ?? ALIA_GEMIE_ID, row.enabled]));
}

export async function setEmailAlertPreference(
  db: Executor,
  input: { oxyUserId: string; agentId: string; enabled: boolean },
): Promise<void> {
  await db
    .insert(emailAlertPreferences)
    .values({ oxyUserId: input.oxyUserId, agentId: input.agentId, enabled: input.enabled })
    .onConflictDoUpdate({
      target: [emailAlertPreferences.oxyUserId, emailAlertPreferences.agentId],
      set: { enabled: input.enabled, updatedAt: sql`date_trunc('milliseconds', now())` },
    });
}

/**
 * Claim one email for a decision, or `null` when it was already claimed.
 *
 * The claim is the idempotency: it is written BEFORE the classifier runs, so a
 * redelivered event — or two replicas handling the same one — finds the row and
 * stops, whatever became of the first attempt.
 */
export async function claimEmailOutreach(
  db: Executor,
  input: { mailboxAccountId: string; messageId: string; oxyUserId: string; agentId: string },
): Promise<string | null> {
  const [row] = await db
    .insert(emailOutreachDecisions)
    .values({ ...input, verdict: 'pending' })
    .onConflictDoNothing({
      target: [emailOutreachDecisions.mailboxAccountId, emailOutreachDecisions.messageId],
    })
    .returning({ id: emailOutreachDecisions.id });
  return row?.id ?? null;
}

/** Record the final verdict of a claimed email. Only a `pending` claim moves. */
export async function settleEmailOutreach(
  db: Executor,
  id: string,
  outcome: {
    verdict: Exclude<EmailOutreachVerdict, 'pending'>;
    reason?: string | null;
    postedMessageId?: string | null;
  },
): Promise<void> {
  await db
    .update(emailOutreachDecisions)
    .set({
      verdict: outcome.verdict,
      reason: outcome.reason ?? null,
      postedMessageId: outcome.postedMessageId ?? null,
      updatedAt: sql`date_trunc('milliseconds', now())`,
    })
    .where(and(eq(emailOutreachDecisions.id, id), eq(emailOutreachDecisions.verdict, 'pending')));
}

export async function findEmailOutreach(db: Executor, mailboxAccountId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(emailOutreachDecisions)
    .where(
      and(
        eq(emailOutreachDecisions.mailboxAccountId, mailboxAccountId),
        eq(emailOutreachDecisions.messageId, messageId),
      ),
    )
    .limit(1);
  return row ?? null;
}
