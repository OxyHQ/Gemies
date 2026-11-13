import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { connectedAccountGrants, connectedAccounts } from '../schema/integrations';
import {
  createPendingConnectedAccount,
  deleteConnectedAccount,
  findAnsweringGemieId,
  findConnectedAccount,
  findConnectedAccountBySession,
  findPersonAccount,
  grantConnectedAccount,
  listAccountsAnsweredBy,
  listAccountsGrantedTo,
  listPersonAccountGrants,
  listPersonAccounts,
  revokeConnectedAccountGrant,
  setAnsweringGemie,
  setConnectedAccountReplies,
  setConnectedAccountSession,
  setConnectedAccountSessionState,
  touchConnectedAccount,
} from '../integrations/connectedAccountRepository';
import { TEST_CHARACTER } from './support/agent-character';

/**
 * A person's connected accounts and their grants (ADR 0035 as amended), against a REAL server: an
 * account is its person's, granted by them to gemies, at most one of which answers it; every reader
 * that serves a person is scoped to them, and every reader that serves a turn to the person AND a
 * gemie granted the account.
 *
 * Ids are prefixed `cau-`, and every gemie is created here.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

async function gemie(id: string): Promise<string> {
  await db.insert(agents).values({
    id,
    oxyAccountId: `cau-bot-${id}`,
    character: TEST_CHARACTER,
    tagline: 'answers messages',
    description: 'a gemie with accounts',
    authorOxyUserId: 'cau-owner',
    category: 'general',
  });
  return id;
}

function pending(oxyUserId: string, platform: 'whatsapp' | 'telegram' = 'whatsapp') {
  return createPendingConnectedAccount(db, { oxyUserId, platform });
}

async function connected(oxyUserId: string, platform: 'whatsapp' | 'telegram' = 'whatsapp') {
  const account = await pending(oxyUserId, platform);
  await setConnectedAccountSessionState(db, account.id, { status: 'connected' });
  return account;
}

describe('an account is its person’s', () => {
  it('lists and finds only the caller’s accounts, several of one platform included', async () => {
    const mine = await pending('cau-p1');
    const second = await pending('cau-p1');
    await pending('cau-p1', 'telegram');
    const otherPerson = await pending('cau-p2');

    const listed = await listPersonAccounts(db, 'cau-p1');
    expect(listed.map((account) => account.platform).sort()).toEqual([
      'telegram',
      'whatsapp',
      'whatsapp',
    ]);
    expect(listed[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      listed[listed.length - 1]?.createdAt.getTime() ?? 0,
    );
    expect((await findPersonAccount(db, mine.id, 'cau-p1'))?.id).toBe(mine.id);
    expect((await findPersonAccount(db, second.id, 'cau-p1'))?.id).toBe(second.id);
    expect(await findPersonAccount(db, otherPerson.id, 'cau-p1')).toBeNull();
    expect(await findPersonAccount(db, 'not-an-id', 'cau-p1')).toBeNull();
  });

  it('keeps who it answers, scoped to its person, and when a message last arrived', async () => {
    const account = await pending('cau-replies');
    expect(account).toMatchObject({
      status: 'qr-pending',
      replies: 'everyone',
      replyChatIds: [],
      groupReplies: 'mentions',
      lastActiveAt: null,
    });
    expect(
      await setConnectedAccountReplies(db, account.id, 'cau-intruder', { replies: 'nobody' }),
    ).toBeNull();
    const chosen = await setConnectedAccountReplies(db, account.id, 'cau-replies', {
      replies: 'chosen',
      replyChatIds: ['c1@s.whatsapp.net'],
    });
    expect(chosen).toMatchObject({
      replies: 'chosen',
      replyChatIds: ['c1@s.whatsapp.net'],
      groupReplies: 'mentions',
    });
    await touchConnectedAccount(db, account.id);
    expect((await findConnectedAccount(db, account.id))?.lastActiveAt).toBeInstanceOf(Date);
  });

  it('refuses a platform other than WhatsApp and Telegram', async () => {
    for (const platform of ['gmail', 'signal']) {
      let caught: unknown;
      try {
        await db.execute(
          sql`insert into ${connectedAccounts} (id, oxy_user_id, platform)
              values (${`cau-${platform}`}, 'cau-platform', ${platform})`,
        );
      } catch (err) {
        caught = err;
      }
      expect(isCheckViolation(caught)).toBe(true);
      expect(constraintNameOf(caught)).toBe('connected_accounts_platform_check');
    }
  });
});

describe('its grants', () => {
  it('reach a turn only for the gemies granted, only connected, and say which one answers', async () => {
    const a = await gemie('cau-g-turn-a');
    const b = await gemie('cau-g-turn-b');
    const account = await pending('cau-turn');
    const ungranted = await connected('cau-turn');
    const othersAccount = await connected('cau-turn-other');
    await grantConnectedAccount(db, account.id, a);
    await grantConnectedAccount(db, account.id, a); // again: nothing changes
    await grantConnectedAccount(db, othersAccount.id, a);
    await setAnsweringGemie(db, account.id, b);

    // Waiting for its scan has no live session.
    expect(await listAccountsGrantedTo(db, { agentId: a, oxyUserId: 'cau-turn' })).toEqual([]);
    await setConnectedAccountSessionState(db, account.id, { status: 'connected' });

    const forA = await listAccountsGrantedTo(db, { agentId: a, oxyUserId: 'cau-turn' });
    expect(forA.map((row) => [row.id, row.answers])).toEqual([[account.id, false]]);
    const forB = await listAccountsGrantedTo(db, { agentId: b, oxyUserId: 'cau-turn' });
    expect(forB.map((row) => [row.id, row.answers])).toEqual([[account.id, true]]);
    expect(forA.some((row) => row.id === ungranted.id)).toBe(false);

    await setConnectedAccountSessionState(db, account.id, { status: 'paused' });
    expect(await listAccountsGrantedTo(db, { agentId: a, oxyUserId: 'cau-turn' })).toEqual([]);
    expect(
      (await listAccountsGrantedTo(db, { agentId: a, oxyUserId: 'cau-turn' }, ['paused'])).map(
        (row) => row.id,
      ),
    ).toEqual([account.id]);
  });

  it('have at most one answering gemie, moved in one step, and none when it is revoked', async () => {
    const a = await gemie('cau-g-answer-a');
    const b = await gemie('cau-g-answer-b');
    const account = await pending('cau-answer');
    expect(await findAnsweringGemieId(db, account.id)).toBeNull();

    await setAnsweringGemie(db, account.id, a);
    expect(await findAnsweringGemieId(db, account.id)).toBe(a);
    await setAnsweringGemie(db, account.id, b);
    expect(await findAnsweringGemieId(db, account.id)).toBe(b);
    // `a` keeps its grant: it no longer answers, it can still use the account.
    const grants = await listPersonAccountGrants(db, 'cau-answer');
    expect(grants.map((grant) => [grant.agentId, grant.answers])).toEqual([
      [a, false],
      [b, true],
    ]);
    expect(grants[0]?.identity).toEqual({ source: 'oxy', oxyAccountId: `cau-bot-${a}` });
    expect((await listAccountsAnsweredBy(db, b)).map((row) => row.id)).toEqual([account.id]);

    // The database refuses a second answering gemie whatever the code does.
    let caught: unknown;
    try {
      await db
        .update(connectedAccountGrants)
        .set({ answers: true })
        .where(eq(connectedAccountGrants.agentId, a));
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);

    expect(await revokeConnectedAccountGrant(db, account.id, a)).toEqual({ answered: false });
    expect(await revokeConnectedAccountGrant(db, account.id, b)).toEqual({ answered: true });
    expect(await findAnsweringGemieId(db, account.id)).toBeNull();

    await setAnsweringGemie(db, account.id, a);
    await setAnsweringGemie(db, account.id, null);
    expect(await findAnsweringGemieId(db, account.id)).toBeNull();
    expect((await listPersonAccountGrants(db, 'cau-answer')).map((g) => g.agentId)).toEqual([a]);
  });

  it('go with their gemie or their account; the account stays its person’s', async () => {
    const a = await gemie('cau-g-delete');
    const account = await pending('cau-d1');
    await setAnsweringGemie(db, account.id, a);
    await db.delete(agents).where(eq(agents.id, a));
    expect(await listPersonAccountGrants(db, 'cau-d1')).toEqual([]);
    expect((await findPersonAccount(db, account.id, 'cau-d1'))?.id).toBe(account.id);

    const b = await gemie('cau-g-delete-b');
    await grantConnectedAccount(db, account.id, b);
    await deleteConnectedAccount(db, account.id);
    expect(
      await db.select().from(connectedAccountGrants).where(eq(connectedAccountGrants.agentId, b)),
    ).toEqual([]);
  });
});

describe('a session sync does not erase what the gateway omitted', () => {
  it('keeps a stored display name when the reply carries none, and stamps the first connection', async () => {
    const account = await pending('cau-sync');
    const first = await setConnectedAccountSessionState(db, account.id, {
      status: 'connected',
      displayName: 'Known Name',
      phoneNumber: '+100',
    });
    const firstConnected = first?.connectedAt;
    expect(firstConnected).toBeInstanceOf(Date);

    const later = await setConnectedAccountSessionState(db, account.id, { status: 'disconnected' });
    const again = await setConnectedAccountSessionState(db, account.id, { status: 'connected' });

    expect(later?.status).toBe('disconnected');
    expect(later?.displayName).toBe('Known Name');
    expect(later?.phoneNumber).toBe('+100');
    expect(again?.connectedAt).toEqual(firstConnected);
    expect(later?._id).toBe(later?.id);
  });
});

describe('workload channel account resolution', () => {
  it('requires a unique connected row for the exact provider session, and names its answering gemie', async () => {
    const a = await gemie('cau-g-session');
    const account = await pending('cau-channel-owner');
    await setConnectedAccountSession(db, account.id, 'channel-reader-session');
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toBeNull();
    await setConnectedAccountSessionState(db, account.id, { status: 'connected' });
    expect(
      await findConnectedAccountBySession(db, 'telegram', 'channel-reader-session'),
    ).toBeNull();
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toMatchObject({ id: account.id, oxyUserId: 'cau-channel-owner', answeringAgentId: null });
    await grantConnectedAccount(db, account.id, a);
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toMatchObject({ answeringAgentId: null });
    await setAnsweringGemie(db, account.id, a);
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toMatchObject({ id: account.id, answeringAgentId: a });

    const ambiguous = await pending('cau-other-channel-owner');
    await setConnectedAccountSession(db, ambiguous.id, 'channel-reader-session');
    await setConnectedAccountSessionState(db, ambiguous.id, { status: 'connected' });
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toBeNull();
    await deleteConnectedAccount(db, ambiguous.id);
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).not.toBeNull();
    await setConnectedAccountSessionState(db, account.id, { status: 'disconnected' });
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toBeNull();
  });
});
