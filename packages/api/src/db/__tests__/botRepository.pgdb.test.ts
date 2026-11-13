import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { botUsers, bots } from '../schema/bots';
import {
  findBotById,
  findBotUser,
  findBotUserByAuthToken,
  findLinkedBotUser,
  findSystemBot,
  linkBotUser,
  logoutBotUser,
  setBotUserAuthToken,
  setBotUserConversation,
  unlinkBotUser,
  upsertBotUser,
} from '../integrations/botRepository';

/**
 * Bots and bot users, against a REAL server.
 *
 * The centre of this file is the ASYMMETRY between two credentials on two
 * tables. `bots.bot_token` is encrypted; `bot_users.auth_token` is plaintext
 * BECAUSE the linking path looks rows up by it. A test that only asserted "the
 * secrets are protected" would pass against a schema that had broken account
 * linking outright, silently.
 *
 * Ids are prefixed `br-` / `bru-` and every list is scoped to a user or platform
 * this file created.
 */

let db: ApiDatabase;

interface NewBot {
  platform: string;
  botId: string;
  name: string;
  userId: string | null;
  botToken: string;
}

function newBot(overrides: Partial<NewBot> = {}): NewBot {
  return {
    platform: 'br-telegram',
    botId: '1000',
    name: 'Owned Bot',
    userId: 'bru-owner',
    botToken: 'PLAINTEXT-BOT-TOKEN',
    ...overrides,
  };
}

/** A bot row, as a gemie's editor or the environment would have stored it. */
async function registerBot(database: ApiDatabase, input: NewBot) {
  const [row] = await database
    .insert(bots)
    .values({ ...input, status: 'active' })
    .returning({ id: bots.id, name: bots.name });
  if (!row) throw new Error('the bot was not stored');
  return { ...row, _id: row.id };
}

/** A system bot is a row with no owner; nothing in the service creates one any more. */
async function insertSystemBot(input: {
  platform: string;
  botId: string;
  name: string;
}): Promise<void> {
  await db.insert(bots).values({ ...input, status: 'active' });
}

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('the two credentials are treated OPPOSITELY, on purpose', () => {
  it('encrypts the platform token at rest', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-asym', botId: 'a1' }));

    const raw = await db.execute<{ token: string }>(
      sql`select bot_token as token from ${bots} where id = ${bot.id}`,
    );
    expect(raw[0]?.token).not.toBe('PLAINTEXT-BOT-TOKEN');
    expect(raw[0]?.token).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  });

  it('finds a bot user by its PLAINTEXT auth token, paired with the expiry', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-token', botId: 't1' }));
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-token',
      platformUserId: 'br-p1',
      chatId: 'c1',
    });

    const expiry = new Date(Date.now() + 15 * 60 * 1000);
    await setBotUserAuthToken(db, botUser.id, 'br-auth-token', expiry);

    expect((await findBotUserByAuthToken(db, bot.id, 'br-auth-token'))?.id).toBe(botUser.id);

    // The expiry is part of the PREDICATE, not a check the caller might forget.
    const afterExpiry = new Date(Date.now() + 16 * 60 * 1000);
    expect(await findBotUserByAuthToken(db, bot.id, 'br-auth-token', afterExpiry)).toBeNull();
  });

  it('keeps the token out of every shape the routes render', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-proj', botId: 'p1' }));
    const read = await findBotById(db, bot.id);
    expect(Object.keys(read ?? {})).not.toContain('botToken');
    // The floor, so the absence above is a column list rather than no row.
    expect(read?.name).toBe('Owned Bot');
    expect(read?._id).toBe(bot.id);
  });

  it("does NOT project the bot user's auth token", async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-noauth', botId: 'n1' }));
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-noauth',
      platformUserId: 'br-p1',
      chatId: 'c1',
    });
    await setBotUserAuthToken(db, botUser.id, 'br-secret-token', new Date(Date.now() + 60_000));

    const read = await findBotUser(db, bot.id, 'br-p1');
    expect(Object.keys(read ?? {})).not.toContain('authToken');
    // Its DEADLINE is projected — the auth-request route echoes it — and that is
    // not the credential.
    expect(read?.authTokenExpiry).toBeInstanceOf(Date);
  });
});

describe('the system bot is the one with no owner', () => {
  it('finds the system bot by user_id IS NULL', async () => {
    await insertSystemBot({ platform: 'br-sys', botId: 's1', name: 'System' });
    await registerBot(db, newBot({ platform: 'br-sys', botId: 'u1', userId: 'bru-someone' }));

    const system = await findSystemBot(db, 'br-sys');
    expect(system?.botId).toBe('s1');
    expect(system?.userId).toBeNull();
  });
});

describe('deleting a bot takes its users with it', () => {
  it('cascades, which is the structural version of the explicit deleteMany', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-cascade', botId: 'c1' }));
    await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-cascade',
      platformUserId: 'br-p1',
      chatId: 'c1',
    });

    await db.delete(bots).where(eq(bots.id, bot.id));

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(botUsers)
      .where(eq(botUsers.botId, bot.id));
    expect(n).toBe(0);
  });
});

describe('a bot user is upserted, not read-then-branched', () => {
  it('creates once and refreshes on the second call', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-upsert', botId: 'u1' }));

    const first = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-upsert',
      platformUserId: 'br-p1',
      chatId: 'chat-1',
      username: 'first',
    });
    const second = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-upsert',
      platformUserId: 'br-p1',
      chatId: 'chat-2',
      username: 'second',
    });

    expect(second.id).toBe(first.id);
    expect(second.chatId).toBe('chat-2');
    expect(second.username).toBe('second');
  });

  it('does not blank a stored display name when the update omits it', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-omit', botId: 'o1' }));

    await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-omit',
      platformUserId: 'br-p1',
      chatId: 'c1',
      displayName: 'Known Name',
    });
    const after = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-omit',
      platformUserId: 'br-p1',
      chatId: 'c2',
    });

    expect(after.displayName).toBe('Known Name');
    expect(after.chatId).toBe('c2');
  });

  it('MERGES metadata rather than replacing it', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-meta', botId: 'm1' }));

    await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-meta',
      platformUserId: 'br-p1',
      chatId: 'c1',
      metadata: { a: 1 },
    });
    const after = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-meta',
      platformUserId: 'br-p1',
      chatId: 'c1',
      metadata: { b: 2 },
    });

    expect(after.metadata).toEqual({ a: 1, b: 2 });
  });

  it('scopes the platform user to the BOT, so two bots can serve one person', async () => {
    const a = await registerBot(db, newBot({ platform: 'br-two', botId: 'b1' }));
    const b = await registerBot(db, newBot({ platform: 'br-two', botId: 'b2' }));
    if (!a || !b) throw new Error('registerBot returned null');

    const ua = await upsertBotUser(db, {
      botId: a.id,
      platform: 'br-two',
      platformUserId: 'same-person',
      chatId: 'c1',
    });
    const ub = await upsertBotUser(db, {
      botId: b.id,
      platform: 'br-two',
      platformUserId: 'same-person',
      chatId: 'c2',
    });

    expect(ua.id).not.toBe(ub.id);
  });
});

describe('a link token is single-use, and unlinking really unlinks', () => {
  it('CLEARS the auth token on redemption, so it cannot be redeemed twice', async () => {
    /**
     * The security-relevant half. `authToken: undefined` through drizzle is a
     * silent no-op, and a
     * redeemed one-time link token would stay live for its remaining 15 minutes
     * — redeemable AGAIN, by anyone still holding it, into a DIFFERENT account.
     */
    const bot = await registerBot(db, newBot({ platform: 'br-link', botId: 'l1' }));
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-link',
      platformUserId: 'br-p1',
      chatId: 'c1',
    });
    await setBotUserAuthToken(db, botUser.id, 'br-once', new Date(Date.now() + 60_000));

    // First redemption succeeds.
    expect(await findBotUserByAuthToken(db, bot.id, 'br-once')).not.toBeNull();
    const linked = await linkBotUser(db, botUser.id, {
      oxyUserId: 'bru-linker',
      oxyTaskId: 'task-abc',
      authToken: 'br-once',
    });
    expect(linked?.isLinked).toBe(true);
    expect(linked?.oxyUserId).toBe('bru-linker');
    expect(linked?.linkedAt).toBeInstanceOf(Date);
    expect(linked?.metadata).not.toHaveProperty('sessionToken');
    expect(linked?.oxyTaskId).toBe('task-abc');
    expect(linked?.oxyTaskState).toBe('active');
    expect(
      await linkBotUser(db, botUser.id, {
        oxyUserId: 'attacker',
        oxyTaskId: 'attack-task',
        authToken: 'br-once',
      }),
    ).toBeNull();

    // The token is GONE — a second attacker holding it gets nothing.
    expect(await findBotUserByAuthToken(db, bot.id, 'br-once')).toBeNull();
    const raw = await db.execute<{ t: string | null; e: string | null }>(
      sql`select auth_token as t, auth_token_expiry as e from ${botUsers} where id = ${botUser.id}`,
    );
    expect(raw[0]?.t).toBeNull();
    expect(raw[0]?.e).toBeNull();
  });

  it('unlinks and detaches the conversation, so the next message starts fresh', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-unlink', botId: 'u1' }));
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-unlink',
      platformUserId: 'br-p1',
      chatId: 'c1',
    });
    await linkBotUser(db, botUser.id, { oxyUserId: 'bru-unlinker', oxyTaskId: 'unlink-task' });
    await setBotUserConversation(db, botUser.id, 'conv-1');
    expect((await findLinkedBotUser(db, bot.id, 'bru-unlinker'))?.conversationId).toBe('conv-1');

    await unlinkBotUser(db, botUser.id);

    const after = await findBotUser(db, bot.id, 'br-p1');
    expect(after?.isLinked).toBe(false);
    expect(after?.oxyTaskId).toBeNull();
    expect(after?.oxyTaskState).toBe('reauth_required');
    expect(after?.oxyUserId).toBeNull();
    expect(after?.conversationId).toBeNull();
    expect(after?.linkedAt).toBeNull();
    expect(await findLinkedBotUser(db, bot.id, 'bru-unlinker')).toBeNull();
  });

  it('logout keeps linked_at as the historical record, unlike unlink', async () => {
    // The two differ by exactly one column, and the source wrote them that way.
    const bot = await registerBot(db, newBot({ platform: 'br-logout', botId: 'g1' }));
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-logout',
      platformUserId: 'br-p1',
      chatId: 'c1',
    });
    await linkBotUser(db, botUser.id, { oxyUserId: 'bru-logout', oxyTaskId: 'logout-task' });

    await logoutBotUser(db, botUser.id);

    const after = await findBotUser(db, bot.id, 'br-p1');
    expect(after?.isLinked).toBe(false);
    expect(after?.oxyTaskId).toBeNull();
    expect(after?.oxyTaskState).toBe('reauth_required');
    expect(after?.oxyUserId).toBeNull();
    expect(after?.linkedAt).toBeInstanceOf(Date);
  });
});
