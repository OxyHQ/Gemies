/**
 * Connected messaging accounts (WhatsApp, Telegram), on Postgres.
 *
 * An account belongs to ONE gemie and was linked by one person (ADR 0035). Every reader that serves
 * a person or a turn is scoped by BOTH: the gemie whose accounts they are, and the person whose they
 * are. A person never sees another person's account on the same gemie, and a gemie's turn never sees
 * another gemie's account of the same person.
 */

import type { GemieAccountPlatform, GemieAccountStatus } from '@gemies/server/internal';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  connectedAccounts,
  type ConnectedAccountGroupReplies,
  type ConnectedAccountReplies,
} from '../schema/integrations';

/** A connected account as every response serves it. */
export interface ConnectedAccountRow {
  _id: string;
  id: string;
  /** The gemie it belongs to. */
  agentId: string;
  platform: GemieAccountPlatform;
  displayName: string | null;
  phoneNumber: string | null;
  status: GemieAccountStatus;
  sessionId: string | null;
  oxyTaskId: string | null;
  oxyTaskState: 'active' | 'reauth_required';
  replies: ConnectedAccountReplies;
  replyChatIds: string[];
  groupReplies: ConnectedAccountGroupReplies;
  lastActiveAt: Date | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = {
  id: connectedAccounts.id,
  agentId: connectedAccounts.agentId,
  platform: connectedAccounts.platform,
  displayName: connectedAccounts.displayName,
  phoneNumber: connectedAccounts.phoneNumber,
  status: connectedAccounts.status,
  sessionId: connectedAccounts.sessionId,
  oxyTaskId: connectedAccounts.oxyTaskId,
  oxyTaskState: connectedAccounts.oxyTaskState,
  replies: connectedAccounts.replies,
  replyChatIds: connectedAccounts.replyChatIds,
  groupReplies: connectedAccounts.groupReplies,
  lastActiveAt: connectedAccounts.lastActiveAt,
  connectedAt: connectedAccounts.connectedAt,
  createdAt: connectedAccounts.createdAt,
  updatedAt: connectedAccounts.updatedAt,
} as const;

function withLegacyId(row: Omit<ConnectedAccountRow, '_id'>): ConnectedAccountRow {
  return { _id: row.id, ...row };
}

/** Whose account, on which gemie: the scope every person-facing and turn-facing read takes. */
export interface GemieAccountScope {
  readonly agentId: string;
  readonly oxyUserId: string;
}

function inScope(scope: GemieAccountScope) {
  return and(
    eq(connectedAccounts.agentId, scope.agentId),
    eq(connectedAccounts.oxyUserId, scope.oxyUserId),
  );
}

/** This person's accounts on this gemie, newest first. */
export async function listGemieAccounts(
  db: ApiDatabase,
  scope: GemieAccountScope,
): Promise<ConnectedAccountRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(inScope(scope))
    .orderBy(desc(connectedAccounts.createdAt));
  return rows.map(withLegacyId);
}

/** One of this person's accounts on this gemie, or `null`. */
export async function findGemieAccount(
  db: ApiDatabase,
  id: string,
  scope: GemieAccountScope,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, id), inScope(scope)))
    .limit(1);
  return row ? withLegacyId(row) : null;
}

/** An account by id, for a caller that already proved it is that account's (a verified channel). */
export async function findConnectedAccount(
  db: ApiDatabase,
  id: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, id))
    .limit(1);
  return row ? withLegacyId(row) : null;
}

/**
 * Every account of a gemie, whoever linked it, with the person — for deleting the gemie, which
 * stops each session and revokes each task before the rows cascade away.
 */
export async function listAccountsOfGemie(
  db: ApiDatabase,
  agentId: string,
): Promise<Array<ConnectedAccountRow & { oxyUserId: string }>> {
  const rows = await db
    .select({ ...COLUMNS, oxyUserId: connectedAccounts.oxyUserId })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.agentId, agentId));
  return rows.map((row) => ({ ...withLegacyId(row), oxyUserId: row.oxyUserId }));
}

/**
 * Create the placeholder every link starts from, waiting for its scan. Awaited, so a storage
 * failure is a 500 rather than an id the client would poll forever.
 */
export async function createPendingConnectedAccount(
  db: ApiDatabase,
  input: GemieAccountScope & { platform: GemieAccountPlatform },
): Promise<ConnectedAccountRow> {
  const [row] = await db
    .insert(connectedAccounts)
    .values({
      oxyUserId: input.oxyUserId,
      agentId: input.agentId,
      platform: input.platform,
      status: 'qr-pending',
    })
    .returning(COLUMNS);

  if (!row) throw new Error('connected account insert returned no row');
  return withLegacyId(row);
}

/** Attach the integrations-service session id. */
export async function setConnectedAccountSession(
  db: ApiDatabase,
  id: string,
  sessionId: string,
): Promise<void> {
  await db.update(connectedAccounts).set({ sessionId }).where(eq(connectedAccounts.id, id));
}

/** What the gateway reported of a session; a field it did not report is left as stored. */
export interface ConnectedAccountSessionPatch {
  readonly status: GemieAccountStatus;
  readonly phoneNumber?: string | null | undefined;
  readonly displayName?: string | null | undefined;
}

/**
 * Store what the gateway reported. A reply that omits a field (or reports it empty) never erases
 * the stored one, and the first time the session is `connected` stamps `connected_at`.
 */
export async function setConnectedAccountSessionState(
  db: ApiDatabase,
  id: string,
  patch: ConnectedAccountSessionPatch,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      status: patch.status,
      ...(patch.phoneNumber ? { phoneNumber: patch.phoneNumber } : {}),
      ...(patch.displayName ? { displayName: patch.displayName } : {}),
      ...(patch.status === 'connected'
        ? { connectedAt: sql`coalesce(${connectedAccounts.connectedAt}, now())` }
        : {}),
    })
    .where(eq(connectedAccounts.id, id))
    .returning(COLUMNS);

  return row ? withLegacyId(row) : null;
}

/** Who the gemie answers on the account. Only the fields given change. */
export interface ConnectedAccountRepliesPatch {
  readonly replies?: ConnectedAccountReplies | undefined;
  readonly replyChatIds?: string[] | undefined;
  readonly groupReplies?: ConnectedAccountGroupReplies | undefined;
}

export async function setConnectedAccountReplies(
  db: ApiDatabase,
  id: string,
  scope: GemieAccountScope,
  patch: ConnectedAccountRepliesPatch,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      ...(patch.replies === undefined ? {} : { replies: patch.replies }),
      ...(patch.replyChatIds === undefined ? {} : { replyChatIds: patch.replyChatIds }),
      ...(patch.groupReplies === undefined ? {} : { groupReplies: patch.groupReplies }),
    })
    .where(and(eq(connectedAccounts.id, id), inScope(scope)))
    .returning(COLUMNS);
  return row ? withLegacyId(row) : null;
}

/** A message arrived on the account. */
export async function touchConnectedAccount(db: ApiDatabase, id: string): Promise<void> {
  await db
    .update(connectedAccounts)
    .set({ lastActiveAt: new Date() })
    .where(eq(connectedAccounts.id, id));
}

/** Remove an account by id. The caller already proved it may (its scope, or the gemie's delete). */
export async function deleteConnectedAccount(db: ApiDatabase, id: string): Promise<void> {
  await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id));
}

/**
 * This person's CONNECTED accounts on this gemie, newest first: what a tool of its turn may use.
 *
 * `status: 'connected'` is in the filter rather than checked afterwards: an account still waiting
 * for its scan, or logged out, has no live session to send through, and a caller that read the row
 * and forgot to look would send into nothing and report success.
 */
export async function listConnectedGemieAccounts(
  db: ApiDatabase,
  scope: GemieAccountScope,
): Promise<ConnectedAccountRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(and(inScope(scope), eq(connectedAccounts.status, 'connected')))
    .orderBy(desc(connectedAccounts.createdAt));
  return rows.map(withLegacyId);
}

/**
 * Resolve only a live gateway session; the person and the gemie come from its stored binding,
 * never from the request.
 */
export async function findConnectedAccountBySession(
  db: ApiDatabase,
  platform: GemieAccountPlatform,
  sessionId: string,
): Promise<(ConnectedAccountRow & { oxyUserId: string }) | null> {
  const rows = await db
    .select({ ...COLUMNS, oxyUserId: connectedAccounts.oxyUserId })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.platform, platform),
        eq(connectedAccounts.sessionId, sessionId),
        eq(connectedAccounts.status, 'connected'),
      ),
    )
    .limit(2);
  // No unique constraint exists on provider session ids. Ambiguity never chooses an owner.
  const row = rows.length === 1 ? rows[0] : undefined;
  return row ? { ...withLegacyId(row), oxyUserId: row.oxyUserId } : null;
}

export async function setConnectedAccountTask(
  db: ApiDatabase,
  id: string,
  taskId: string | null,
  expectedTaskId?: string | null,
): Promise<boolean> {
  const rows = await db
    .update(connectedAccounts)
    .set({ oxyTaskId: taskId, oxyTaskState: taskId ? 'active' : 'reauth_required' })
    .where(
      and(
        eq(connectedAccounts.id, id),
        ...(expectedTaskId === undefined
          ? []
          : [
              expectedTaskId === null
                ? isNull(connectedAccounts.oxyTaskId)
                : eq(connectedAccounts.oxyTaskId, expectedTaskId),
            ]),
      ),
    )
    .returning({ id: connectedAccounts.id });
  return rows.length === 1;
}
