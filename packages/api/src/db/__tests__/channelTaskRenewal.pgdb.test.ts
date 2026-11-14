/**
 * Channels' Oxy tasks on a real Postgres (`channelTaskRepository.ts`, `channel-task-authority.ts`):
 * which bindings are live, how a task past its expiry or refused by Oxy lapses in all three
 * tables, that the sweep tells each person exactly once (also when two instances sweep together),
 * and that a new task clears the notice so the next lapse is told again.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ notifications: [] as Array<Record<string, unknown>> }));
vi.mock('../../lib/notification-service.js', () => ({
  sendNotification: async (options: Record<string, unknown>) => {
    sent.notifications.push(options);
    return {};
  },
}));
vi.mock('../../lib/connected-accounts.js', () => ({ notifyAccountPerson: async () => ({}) }));
vi.mock('../../lib/channels/outbound.js', () => ({
  sendChannelMessage: async () => [{ ok: true }],
}));
vi.mock('../../lib/gemie-telegram-bot-setup.js', () => ({ relayToGemieBotChat: async () => {} }));
vi.mock('../../lib/memory/user-memory-service.js', () => ({ messageLanguageOf: async () => 'en' }));

import { ALIA_GEMIE_ID } from '../../domain/alia-gemie.js';
import { sweepChannelTasks } from '../../lib/channel-task-authority.js';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index.js';
import { upsertBotUser } from '../integrations/botRepository.js';
import {
  bindChannelTask,
  claimChannelTaskNotices,
  lapseExpiredChannelTasks,
  lapseRefusedChannelTask,
  listPersonChannelBindings,
  releaseChannelTaskNotice,
} from '../integrations/channelTaskRepository.js';
import {
  createPendingConnectedAccount,
  setAnsweringGemie,
  setConnectedAccountTask,
} from '../integrations/connectedAccountRepository.js';
import { bots, botUsers } from '../schema/bots.js';
import { connectedAccounts } from '../schema/integrations.js';

let db: ApiDatabase;
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  db = connectPostgres(process.env.DATABASE_URL)!;
});
afterAll(closePostgres);
beforeEach(() => {
  sent.notifications = [];
});

const DAY = 86_400_000;
let sequence = 0;

/** One person with one live binding of each kind, each holding a task that lapses at `expiresAt`. */
async function person(expiresAt: Date) {
  const personId = `channel-renewal-${process.pid}-${sequence++}`;
  const task = (name: string) => ({ id: `${personId}-${name}`, expiresAt });

  const account = await createPendingConnectedAccount(db, {
    oxyUserId: personId,
    platform: 'telegram',
  });
  await setAnsweringGemie(db, account.id, ALIA_GEMIE_ID);
  await db
    .update(connectedAccounts)
    .set({ status: 'connected', sessionId: `${personId}-session` })
    .where(eq(connectedAccounts.id, account.id));
  await setConnectedAccountTask(db, account.id, task('account'), null);

  const [systemBot] = await db
    .insert(bots)
    .values({
      platform: `discord-${personId}`,
      botId: `${personId}-system`,
      name: 'system',
      status: 'active',
    })
    .returning({ id: bots.id });
  if (!systemBot) throw new Error('system bot not created');
  const link = await upsertBotUser(db, {
    botId: systemBot.id,
    platform: 'discord',
    platformUserId: `${personId}-discord`,
    chatId: `${personId}-dm`,
  });
  await db
    .update(botUsers)
    .set({ oxyUserId: personId, isLinked: true })
    .where(eq(botUsers.id, link.id));

  const [gemieBot] = await db
    .insert(bots)
    .values({
      platform: 'telegram',
      botId: String(9_000_000_000 + sequence),
      name: 'gemie bot',
      status: 'active',
      agentId: `${personId}-gemie`,
      userId: personId,
      linkedTelegramUserId: String(570_000_000 + sequence),
    })
    .returning({ id: bots.id });
  if (!gemieBot) throw new Error('gemie bot not created');

  // The two bot rows, as the link flows leave them.
  const held = {
    oxyTaskState: 'active' as const,
    oxyTaskExpiresAt: expiresAt,
    oxyTaskNotifiedAt: null,
  };
  await db
    .update(botUsers)
    .set({ ...held, oxyTaskId: task('link').id })
    .where(eq(botUsers.id, link.id));
  await db
    .update(bots)
    .set({ ...held, oxyTaskId: task('bot').id })
    .where(eq(bots.id, gemieBot.id));
  return { personId, accountId: account.id, linkId: link.id, gemieBotId: gemieBot.id };
}

const mine = (personId: string) =>
  sent.notifications.filter((notification) => notification.userId === personId);

describe('live channel bindings', () => {
  it('lists each kind once, with its task, and only while its channel delivers', async () => {
    const p = await person(new Date(Date.now() + 100 * DAY));
    const bindings = await listPersonChannelBindings(db, p.personId);
    expect(bindings.map((binding) => [binding.kind, binding.id]).sort()).toEqual(
      [
        ['account', p.accountId],
        ['bot_link', p.linkId],
        ['gemie_bot', p.gemieBotId],
      ].sort(),
    );
    expect(bindings.find((binding) => binding.kind === 'gemie_bot')).toMatchObject({
      gemieId: `${p.personId}-gemie`,
      personChat: expect.stringMatching(/^telegram:\d+:\d+$/),
      oxyTaskState: 'active',
    });
    expect(bindings.find((binding) => binding.kind === 'bot_link')?.personChat).toBe(
      `${p.personId}-dm`,
    );

    // A disconnected account, an unlinked person and an inactive bot need no task.
    await db
      .update(connectedAccounts)
      .set({ status: 'disconnected' })
      .where(eq(connectedAccounts.id, p.accountId));
    await db.update(botUsers).set({ isLinked: false }).where(eq(botUsers.id, p.linkId));
    await db.update(bots).set({ status: 'inactive' }).where(eq(bots.id, p.gemieBotId));
    expect(await listPersonChannelBindings(db, p.personId)).toEqual([]);
  });
});

describe('a task that lapses', () => {
  it('is marked reauth_required past the expiry Oxy gave it, in all three tables', async () => {
    const expired = await person(new Date(Date.now() - 1000));
    const fine = await person(new Date(Date.now() + 100 * DAY));
    expect(await lapseExpiredChannelTasks(db, new Date())).toBeGreaterThanOrEqual(3);
    const states = async (personId: string) =>
      (await listPersonChannelBindings(db, personId)).map((binding) => binding.oxyTaskState);
    expect(await states(expired.personId)).toEqual([
      'reauth_required',
      'reauth_required',
      'reauth_required',
    ]);
    expect(await states(fine.personId)).toEqual(['active', 'active', 'active']);
  });

  it('is marked reauth_required wherever it is held when Oxy refuses it', async () => {
    const p = await person(new Date(Date.now() + 100 * DAY));
    expect(await lapseRefusedChannelTask(db, `${p.personId}-link`)).toBe(1);
    const bindings = await listPersonChannelBindings(db, p.personId);
    expect(bindings.find((binding) => binding.kind === 'bot_link')?.oxyTaskState).toBe(
      'reauth_required',
    );
    expect(bindings.find((binding) => binding.kind === 'account')?.oxyTaskState).toBe('active');
    expect(await lapseRefusedChannelTask(db, 'a-task-nobody-holds')).toBe(0);
  });
});

describe('telling the person', () => {
  it('tells them once of each channel whose task lapsed or lapses soon, never of a far one', async () => {
    const soon = await person(new Date(Date.now() + 3 * DAY));
    const far = await person(new Date(Date.now() + 100 * DAY));
    await sweepChannelTasks();
    expect(mine(soon.personId)).toHaveLength(3);
    expect(mine(soon.personId)[0]).toMatchObject({
      type: 'integration_event',
      data: expect.objectContaining({ path: '/channels/reauthorize' }),
    });
    expect(mine(far.personId)).toHaveLength(0);

    // Once: the next sweep finds nothing new to tell, even after the soon one lapses.
    await sweepChannelTasks(new Date(Date.now() + 4 * DAY));
    expect(mine(soon.personId)).toHaveLength(3);
  });

  it('is claimed by one sweep when two instances sweep together', async () => {
    const p = await person(new Date(Date.now() + 100 * DAY));
    await db
      .update(botUsers)
      .set({ oxyTaskState: 'reauth_required' })
      .where(eq(botUsers.id, p.linkId));
    const now = new Date();
    const claims = await Promise.all(
      [0, 1, 2].map(() =>
        claimChannelTaskNotices(db, {
          now,
          noticeBefore: new Date(now.getTime() + DAY),
          limit: 500,
        }),
      ),
    );
    const claimedLink = claims.flat().filter((binding) => binding.id === p.linkId);
    expect(claimedLink).toHaveLength(1);
  });

  it('is claimed again when it could not be sent, and again after a new task lapses', async () => {
    const p = await person(new Date(Date.now() - 1000));
    await sweepChannelTasks();
    expect(mine(p.personId)).toHaveLength(3);

    const [account] = (await listPersonChannelBindings(db, p.personId)).filter(
      (binding) => binding.kind === 'account',
    );
    if (!account) throw new Error('no account binding');
    await releaseChannelTaskNotice(db, account);
    await sweepChannelTasks();
    expect(mine(p.personId)).toHaveLength(4);

    // Renewed with a present session: active again, with Oxy's expiry, and no notice sent yet.
    const renewed = { id: randomUUID(), expiresAt: new Date(Date.now() + 2 * DAY) };
    expect(await bindChannelTask(db, account, renewed)).toBe(true);
    // Read with the task it held: a second renewal from the same read changes nothing.
    expect(await bindChannelTask(db, account, { id: randomUUID(), expiresAt: new Date() })).toBe(
      false,
    );
    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, p.accountId));
    expect(row).toMatchObject({
      oxyTaskId: renewed.id,
      oxyTaskState: 'active',
      oxyTaskExpiresAt: renewed.expiresAt,
      oxyTaskNotifiedAt: null,
    });
    await sweepChannelTasks();
    expect(mine(p.personId)).toHaveLength(5);
  });
});
