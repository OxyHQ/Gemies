/**
 * Connected messaging accounts (WhatsApp, Telegram), on Postgres.
 *
 * An account belongs to ONE gemie and was linked by one person (ADR 0035). Every reader that serves
 * a person or a turn is scoped by BOTH: the gemie whose accounts they are, and the person whose they
 * are. A person never sees another person's account on the same gemie, and a gemie's turn never sees
 * another gemie's account of the same person.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import {
  connectedAccounts,
  type ConnectedAccountPlatform,
  type ConnectedAccountStatus,
} from '../schema/integrations';

/** A connected account as every response serves it. */
export interface ConnectedAccountRow {
  _id: string;
  id: string;
  /** The gemie it belongs to. */
  agentId: string;
  platform: ConnectedAccountPlatform;
  accountId: string;
  displayName: string | null;
  phoneNumber: string | null;
  avatarUrl: string | null;
  status: ConnectedAccountStatus;
  statusMessage: string | null;
  sessionId: string | null;
  oxyTaskId: string | null;
  oxyTaskState: 'active' | 'reauth_required';
  capabilities: string[];
  metadata: Record<string, unknown>;
  lastActiveAt: Date | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = {
  id: connectedAccounts.id,
  agentId: connectedAccounts.agentId,
  platform: connectedAccounts.platform,
  accountId: connectedAccounts.accountId,
  displayName: connectedAccounts.displayName,
  phoneNumber: connectedAccounts.phoneNumber,
  avatarUrl: connectedAccounts.avatarUrl,
  status: connectedAccounts.status,
  statusMessage: connectedAccounts.statusMessage,
  sessionId: connectedAccounts.sessionId,
  oxyTaskId: connectedAccounts.oxyTaskId,
  oxyTaskState: connectedAccounts.oxyTaskState,
  capabilities: connectedAccounts.capabilities,
  metadata: connectedAccounts.metadata,
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
 * Create the `connecting` placeholder every connect flow starts from. Awaited, so a storage failure
 * is a 500 rather than an id the client would poll forever.
 */
export async function createPendingConnectedAccount(
  db: ApiDatabase,
  input: GemieAccountScope & { platform: ConnectedAccountPlatform; capabilities: string[] },
): Promise<ConnectedAccountRow> {
  const [row] = await db
    .insert(connectedAccounts)
    .values({
      oxyUserId: input.oxyUserId,
      agentId: input.agentId,
      platform: input.platform,
      accountId: 'pending',
      status: 'connecting',
      capabilities: input.capabilities,
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

/** Record a status the integrations service reported, or a local disconnect. */
export interface ConnectedAccountStatusPatch {
  readonly status: ConnectedAccountStatus;
  readonly phoneNumber?: string | undefined;
  readonly displayName?: string | undefined;
  readonly accountId?: string | undefined;
  readonly connectedAt?: Date | undefined;
}

/**
 * Apply a status sync. Every optional field is spread rather than defaulted to `null`: a status poll
 * that omits a display name must not erase the one already stored.
 */
export async function setConnectedAccountStatus(
  db: ApiDatabase,
  id: string,
  patch: ConnectedAccountStatusPatch,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      status: patch.status,
      ...(patch.phoneNumber === undefined ? {} : { phoneNumber: patch.phoneNumber }),
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.accountId === undefined ? {} : { accountId: patch.accountId }),
      ...(patch.connectedAt === undefined ? {} : { connectedAt: patch.connectedAt }),
    })
    .where(eq(connectedAccounts.id, id))
    .returning(COLUMNS);

  return row ? withLegacyId(row) : null;
}

/** Remove an account by id. The caller already proved it may (its scope, or the gemie's delete). */
export async function deleteConnectedAccount(db: ApiDatabase, id: string): Promise<void> {
  await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id));
}

/**
 * This person's CONNECTED account on one platform of this gemie, for a tool of its turn.
 *
 * `status: 'connected'` is in the filter rather than checked afterwards: an account still
 * `connecting`, or `expired`, has no live session to send through, and a caller that read the row
 * and forgot to look would send into nothing and report success.
 */
export async function findConnectedGemieAccount(
  db: ApiDatabase,
  scope: GemieAccountScope,
  platform: ConnectedAccountPlatform,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        inScope(scope),
        eq(connectedAccounts.platform, platform),
        eq(connectedAccounts.status, 'connected'),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);

  return row ? withLegacyId(row) : null;
}

/**
 * Resolve only a live gateway session; the person and the gemie come from its stored binding,
 * never from the request.
 */
export async function findConnectedAccountBySession(
  db: ApiDatabase,
  platform: ConnectedAccountPlatform,
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
