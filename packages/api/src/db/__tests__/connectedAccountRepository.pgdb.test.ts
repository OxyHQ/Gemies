import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { connectedAccounts } from '../schema/integrations';
import {
  createPendingConnectedAccount,
  deleteConnectedAccount,
  findConnectedAccountBySession,
  findConnectedGemieAccount,
  findGemieAccount,
  listAccountsOfGemie,
  listGemieAccounts,
  setConnectedAccountSession,
  setConnectedAccountStatus,
} from '../integrations/connectedAccountRepository';
import { TEST_CHARACTER } from './support/agent-character';

/**
 * A gemie's connected accounts (ADR 0035), against a REAL server: an account belongs to one gemie
 * and was linked by one person, and every reader that serves a person or a turn is scoped by both.
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

async function pending(
  agentId: string,
  oxyUserId: string,
  platform: 'whatsapp' | 'telegram' = 'whatsapp',
) {
  return createPendingConnectedAccount(db, {
    agentId,
    oxyUserId,
    platform,
    capabilities: ['read_messages', 'send_messages'],
  });
}

describe('an account belongs to one gemie and one person', () => {
  it('lists, finds and reaches only the caller’s accounts on that gemie', async () => {
    const a = await gemie('cau-g-a');
    const b = await gemie('cau-g-b');
    const mine = await pending(a, 'cau-p1');
    await pending(a, 'cau-p1', 'telegram');
    const otherGemie = await pending(b, 'cau-p1');
    const otherPerson = await pending(a, 'cau-p2');

    const listed = await listGemieAccounts(db, { agentId: a, oxyUserId: 'cau-p1' });
    expect(listed.map((account) => account.platform).sort()).toEqual(['telegram', 'whatsapp']);
    expect(listed.every((account) => account.agentId === a)).toBe(true);
    expect(listed[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      listed[listed.length - 1]?.createdAt.getTime() ?? 0,
    );

    const scope = { agentId: a, oxyUserId: 'cau-p1' };
    expect((await findGemieAccount(db, mine.id, scope))?.id).toBe(mine.id);
    expect(await findGemieAccount(db, otherGemie.id, scope)).toBeNull();
    expect(await findGemieAccount(db, otherPerson.id, scope)).toBeNull();
    expect(await findGemieAccount(db, 'not-an-id', scope)).toBeNull();
  });

  it('gives a turn only the gemie’s CONNECTED account of its person', async () => {
    const a = await gemie('cau-g-turn');
    const b = await gemie('cau-g-turn-other');
    const scope = { agentId: a, oxyUserId: 'cau-turn' };
    const account = await pending(a, 'cau-turn');
    const elsewhere = await pending(b, 'cau-turn');
    await setConnectedAccountStatus(db, elsewhere.id, { status: 'connected' });

    // `connecting` has no live session; another gemie's connected WhatsApp is never this turn's.
    expect(await findConnectedGemieAccount(db, scope, 'whatsapp')).toBeNull();
    await setConnectedAccountStatus(db, account.id, { status: 'connected' });
    expect((await findConnectedGemieAccount(db, scope, 'whatsapp'))?.id).toBe(account.id);
    expect(await findConnectedGemieAccount(db, scope, 'telegram')).toBeNull();
    await setConnectedAccountStatus(db, account.id, { status: 'disconnected' });
    expect(await findConnectedGemieAccount(db, scope, 'whatsapp')).toBeNull();
  });

  it('goes with its gemie, and the gemie lists all of them first, whoever linked them', async () => {
    const a = await gemie('cau-g-delete');
    await pending(a, 'cau-d1');
    await pending(a, 'cau-d2', 'telegram');
    const all = await listAccountsOfGemie(db, a);
    expect(all.map((account) => account.oxyUserId).sort()).toEqual(['cau-d1', 'cau-d2']);

    await db.delete(agents).where(eq(agents.id, a));
    expect(await listAccountsOfGemie(db, a)).toEqual([]);
  });

  it('refuses a platform other than WhatsApp and Telegram, and an account with no gemie', async () => {
    const a = await gemie('cau-g-platform');
    for (const platform of ['gmail', 'signal']) {
      let caught: unknown;
      try {
        await db.execute(
          sql`insert into ${connectedAccounts} (id, oxy_user_id, agent_id, platform, account_id)
              values (${`cau-${platform}`}, 'cau-platform', ${a}, ${platform}, 'pending')`,
        );
      } catch (err) {
        caught = err;
      }
      expect(isCheckViolation(caught)).toBe(true);
      expect(constraintNameOf(caught)).toBe('connected_accounts_platform_check');
    }
    await expect(
      db.execute(
        sql`insert into ${connectedAccounts} (id, oxy_user_id, platform, account_id)
            values ('cau-no-gemie', 'cau-platform', 'whatsapp', 'pending')`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      // 23502: not_null_violation, on `agent_id`.
      const cause = (error as { cause?: { code?: string; column_name?: string } }).cause;
      expect(cause?.code).toBe('23502');
      expect(cause?.column_name).toBe('agent_id');
      return true;
    });
  });
});

describe('a status sync does not erase what the poll omitted', () => {
  it('keeps a stored display name when the reply carries none', async () => {
    const account = await pending(await gemie('cau-g-sync'), 'cau-sync');
    await setConnectedAccountStatus(db, account.id, {
      status: 'connected',
      displayName: 'Known Name',
      phoneNumber: '+100',
    });

    const later = await setConnectedAccountStatus(db, account.id, { status: 'expired' });

    expect(later?.status).toBe('expired');
    expect(later?.displayName).toBe('Known Name');
    expect(later?.phoneNumber).toBe('+100');
    expect(later?._id).toBe(later?.id);
  });
});

describe('workload channel account resolution', () => {
  it('requires a unique connected row for the exact provider session, and names its gemie', async () => {
    const a = await gemie('cau-g-session');
    const account = await pending(a, 'cau-channel-owner');
    await setConnectedAccountSession(db, account.id, 'channel-reader-session');
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toBeNull();
    await setConnectedAccountStatus(db, account.id, { status: 'connected' });
    expect(
      await findConnectedAccountBySession(db, 'telegram', 'channel-reader-session'),
    ).toBeNull();
    const found = await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session');
    expect(found).toMatchObject({ id: account.id, oxyUserId: 'cau-channel-owner', agentId: a });
    const ambiguous = await pending(a, 'cau-other-channel-owner');
    await setConnectedAccountSession(db, ambiguous.id, 'channel-reader-session');
    await setConnectedAccountStatus(db, ambiguous.id, { status: 'connected' });
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toBeNull();
    await deleteConnectedAccount(db, ambiguous.id);
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).not.toBeNull();
    await setConnectedAccountStatus(db, account.id, { status: 'disconnected' });
    expect(
      await findConnectedAccountBySession(db, 'whatsapp', 'channel-reader-session'),
    ).toBeNull();
  });
});
