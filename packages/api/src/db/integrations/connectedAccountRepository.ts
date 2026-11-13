/**
 * Connected messaging accounts (WhatsApp, Telegram Business) and their grants, on Postgres.
 *
 * An account is its PERSON's (ADR 0035 as amended): connected once, and granted by that person to
 * the gemies that may use it, at most one of which answers it. Every reader that serves a person is
 * scoped to them, and every reader that serves a turn to the person AND the turn's gemie, through a
 * grant: a gemie never sees an account of its person it was not granted, nor anybody else's.
 */

import type { GemieAccountPlatform, GemieAccountStatus } from '@gemies/server/internal';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { StoredAgentIdentity } from '../../domain/agent';
import type { ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import {
  connectedAccountGrants,
  connectedAccounts,
  type ConnectedAccountGroupReplies,
  type ConnectedAccountReplies,
} from '../schema/integrations';
import { agentIdentityColumns, readStoredIdentity } from '../agents/storedIdentity';

/** A connected account as every response serves it. */
export interface ConnectedAccountRow {
  _id: string;
  id: string;
  /** The person whose account it is. */
  oxyUserId: string;
  platform: GemieAccountPlatform;
  displayName: string | null;
  phoneNumber: string | null;
  status: GemieAccountStatus;
  /** Whether the platform lets a gemie write from it; `null` where it grants no such right. */
  canReply: boolean | null;
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
  oxyUserId: connectedAccounts.oxyUserId,
  platform: connectedAccounts.platform,
  displayName: connectedAccounts.displayName,
  phoneNumber: connectedAccounts.phoneNumber,
  status: connectedAccounts.status,
  canReply: connectedAccounts.canReply,
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

/** One account of the person's, or a scope a write must stay inside. */
function personsAccount(id: string, oxyUserId: string) {
  return and(eq(connectedAccounts.id, id), eq(connectedAccounts.oxyUserId, oxyUserId));
}

/** This person's accounts, newest first. */
export async function listPersonAccounts(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<ConnectedAccountRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(eq(connectedAccounts.oxyUserId, oxyUserId))
    .orderBy(desc(connectedAccounts.createdAt), desc(connectedAccounts.id));
  return rows.map(withLegacyId);
}

/** One of this person's accounts, or `null`. */
export async function findPersonAccount(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(personsAccount(id, oxyUserId))
    .limit(1);
  return row ? withLegacyId(row) : null;
}

/**
 * A person's newest account of one platform that still has its session: where a notification of
 * theirs (not a gemie's turn) reaches them.
 */
export async function findPersonAccountOf(
  db: ApiDatabase,
  oxyUserId: string,
  platform: GemieAccountPlatform,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.oxyUserId, oxyUserId),
        eq(connectedAccounts.platform, platform),
        isNotNull(connectedAccounts.sessionId),
        ne(connectedAccounts.status, 'logged-out'),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
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
 * Create the placeholder every link starts from, waiting for its scan. Awaited, so a storage
 * failure is a 500 rather than an id the client would poll forever. It is granted to nobody: the
 * person chooses its gemies once it is connected.
 */
export async function createPendingConnectedAccount(
  db: ApiDatabase,
  input: { oxyUserId: string; platform: GemieAccountPlatform },
): Promise<ConnectedAccountRow> {
  const [row] = await db
    .insert(connectedAccounts)
    .values({ oxyUserId: input.oxyUserId, platform: input.platform, status: 'qr-pending' })
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
  readonly canReply?: boolean | null | undefined;
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
      ...(typeof patch.canReply === 'boolean' ? { canReply: patch.canReply } : {}),
      ...(patch.status === 'connected'
        ? { connectedAt: sql`coalesce(${connectedAccounts.connectedAt}, now())` }
        : {}),
    })
    .where(eq(connectedAccounts.id, id))
    .returning(COLUMNS);

  return row ? withLegacyId(row) : null;
}

/** Who the answering gemie answers on the account. Only the fields given change. */
export interface ConnectedAccountRepliesPatch {
  readonly replies?: ConnectedAccountReplies | undefined;
  readonly replyChatIds?: string[] | undefined;
  readonly groupReplies?: ConnectedAccountGroupReplies | undefined;
}

export async function setConnectedAccountReplies(
  db: ApiDatabase,
  id: string,
  oxyUserId: string,
  patch: ConnectedAccountRepliesPatch,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({
      ...(patch.replies === undefined ? {} : { replies: patch.replies }),
      ...(patch.replyChatIds === undefined ? {} : { replyChatIds: patch.replyChatIds }),
      ...(patch.groupReplies === undefined ? {} : { groupReplies: patch.groupReplies }),
    })
    .where(personsAccount(id, oxyUserId))
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

/** Remove an account by id, and its grants with it. The caller already proved it is the person's. */
export async function deleteConnectedAccount(db: ApiDatabase, id: string): Promise<void> {
  await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id));
}

/* ------------------------------ grants ------------------------------ */

/** A gemie granted one of the person's accounts, with whether it answers it. */
export interface ConnectedAccountGrant {
  readonly accountId: string;
  readonly agentId: string;
  readonly answers: boolean;
  readonly identity: StoredAgentIdentity;
}

/** Every grant of this person's accounts, with each gemie's stored identity, oldest first. */
export async function listPersonAccountGrants(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<ConnectedAccountGrant[]> {
  const rows = await db
    .select({
      accountId: connectedAccountGrants.accountId,
      agentId: connectedAccountGrants.agentId,
      answers: connectedAccountGrants.answers,
      ...agentIdentityColumns,
    })
    .from(connectedAccountGrants)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, connectedAccountGrants.accountId))
    .innerJoin(agents, eq(agents.id, connectedAccountGrants.agentId))
    .where(eq(connectedAccounts.oxyUserId, oxyUserId))
    .orderBy(connectedAccountGrants.createdAt, connectedAccountGrants.agentId);
  return rows.map((row) => ({
    accountId: row.accountId,
    agentId: row.agentId,
    answers: row.answers,
    identity: readStoredIdentity(row),
  }));
}

/** The gemie that answers the account, or `null` when none does. */
export async function findAnsweringGemieId(
  db: ApiDatabase,
  accountId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ agentId: connectedAccountGrants.agentId })
    .from(connectedAccountGrants)
    .where(
      and(
        eq(connectedAccountGrants.accountId, accountId),
        eq(connectedAccountGrants.answers, true),
      ),
    )
    .limit(1);
  return row?.agentId ?? null;
}

/** Let a gemie use the account. Granting it again changes nothing. */
export async function grantConnectedAccount(
  db: ApiDatabase,
  accountId: string,
  agentId: string,
): Promise<void> {
  await db
    .insert(connectedAccountGrants)
    .values({ accountId, agentId })
    .onConflictDoNothing({
      target: [connectedAccountGrants.accountId, connectedAccountGrants.agentId],
    });
}

/** Stop a gemie using the account. Answers whether it was the one answering it. */
export async function revokeConnectedAccountGrant(
  db: ApiDatabase,
  accountId: string,
  agentId: string,
): Promise<{ answered: boolean }> {
  const [row] = await db
    .delete(connectedAccountGrants)
    .where(
      and(
        eq(connectedAccountGrants.accountId, accountId),
        eq(connectedAccountGrants.agentId, agentId),
      ),
    )
    .returning({ answers: connectedAccountGrants.answers });
  return { answered: row?.answers === true };
}

/**
 * Make `agentId` the gemie that answers the account, granting it the account if it was not, or
 * make none answer it (`null`). One transaction, so the account never has two answering gemies
 * (`connected_account_grants_one_answering_idx` refuses the second regardless).
 */
export async function setAnsweringGemie(
  db: ApiDatabase,
  accountId: string,
  agentId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(connectedAccountGrants)
      .set({ answers: false })
      .where(
        and(
          eq(connectedAccountGrants.accountId, accountId),
          eq(connectedAccountGrants.answers, true),
        ),
      );
    if (agentId === null) return;
    await tx
      .insert(connectedAccountGrants)
      .values({ accountId, agentId, answers: true })
      .onConflictDoUpdate({
        target: [connectedAccountGrants.accountId, connectedAccountGrants.agentId],
        set: { answers: true },
      });
  });
}

/** A connected account a turn's gemie was granted, with whether that gemie answers it. */
export type GrantedConnectedAccount = ConnectedAccountRow & { readonly answers: boolean };

/**
 * This person's accounts granted to this gemie, newest first: what a tool of its turn may use, and
 * nothing else. Only `connected` ones unless the caller names other statuses.
 *
 * The status is in the filter rather than checked afterwards: an account still waiting for its
 * scan, or logged out, has no live session to send through, and a caller that read the row and
 * forgot to look would send into nothing and report success.
 */
export async function listAccountsGrantedTo(
  db: ApiDatabase,
  scope: { readonly agentId: string; readonly oxyUserId: string },
  statuses: readonly GemieAccountStatus[] = ['connected'],
): Promise<GrantedConnectedAccount[]> {
  const rows = await db
    .select({ ...COLUMNS, answers: connectedAccountGrants.answers })
    .from(connectedAccounts)
    .innerJoin(connectedAccountGrants, eq(connectedAccountGrants.accountId, connectedAccounts.id))
    .where(
      and(
        eq(connectedAccountGrants.agentId, scope.agentId),
        eq(connectedAccounts.oxyUserId, scope.oxyUserId),
        inArray(connectedAccounts.status, [...statuses]),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt), desc(connectedAccounts.id));
  return rows.map(({ answers, ...row }) => ({ ...withLegacyId(row), answers }));
}

/**
 * Every account a gemie answers, whoever's it is — for deleting the gemie, which revokes each
 * one's task before the grants cascade away. The accounts stay their people's.
 */
export async function listAccountsAnsweredBy(
  db: ApiDatabase,
  agentId: string,
): Promise<ConnectedAccountRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(connectedAccounts)
    .innerJoin(connectedAccountGrants, eq(connectedAccountGrants.accountId, connectedAccounts.id))
    .where(
      and(eq(connectedAccountGrants.agentId, agentId), eq(connectedAccountGrants.answers, true)),
    );
  return rows.map(withLegacyId);
}

/**
 * Resolve only a live gateway session; the person and the answering gemie come from its stored
 * binding and grants, never from the request. `answeringAgentId` is `null` when no gemie answers.
 */
export async function findConnectedAccountBySession(
  db: ApiDatabase,
  platform: GemieAccountPlatform,
  sessionId: string,
): Promise<(ConnectedAccountRow & { oxyUserId: string; answeringAgentId: string | null }) | null> {
  const rows = await db
    .select({
      ...COLUMNS,
      answeringAgentId: connectedAccountGrants.agentId,
    })
    .from(connectedAccounts)
    .leftJoin(
      connectedAccountGrants,
      and(
        eq(connectedAccountGrants.accountId, connectedAccounts.id),
        eq(connectedAccountGrants.answers, true),
      ),
    )
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
  if (!row) return null;
  const { answeringAgentId, ...account } = row;
  return { ...withLegacyId(account), answeringAgentId };
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
