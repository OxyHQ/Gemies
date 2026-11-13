import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { botUsers, bots } from '../schema/bots';

/**
 * Bots, against a REAL server: the token is encrypted, a platform identity and a gemie's bot are
 * unique, and the closed value sets are CHECKed.
 */

let db: ApiDatabase;

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('a bot and its token', () => {
  it('encrypts the platform token at rest', async () => {
    await db.insert(bots).values({
      id: 'bot-token',
      platform: 'telegram',
      botId: 'tg-1',
      name: 'Token Bot',
      botToken: 'plaintext-bot-token',
    });

    const raw = await db.execute<{ token: string }>(
      sql`select bot_token as token from ${bots} where id = 'bot-token'`,
    );
    expect(raw[0]?.token).not.toBe('plaintext-bot-token');
    expect(raw[0]?.token).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    const [row] = await db
      .select({ token: bots.botToken })
      .from(bots)
      .where(eq(bots.id, 'bot-token'));
    expect(row?.token).toBe('plaintext-bot-token');
  });

  it('gives a gemie at most one bot on a platform', async () => {
    await db.insert(bots).values({
      id: 'bot-hook',
      platform: 'telegram',
      botId: 'tg-2',
      name: 'Gemie Bot',
      userId: 'oxy-user-1',
      agentId: 'gemie-1',
    });
    const second = db.insert(bots).values({
      id: 'bot-gemie-2',
      platform: 'telegram',
      botId: 'tg-g2',
      name: 'Gemie Bot 2',
      userId: 'oxy-user-1',
      agentId: 'gemie-1',
    });

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('bots_agent_platform_key');
      return true;
    });
  });

  it('refuses two bots with the same platform identity', async () => {
    const duplicate = db.insert(bots).values({
      id: 'bot-dup',
      platform: 'telegram',
      botId: 'tg-1',
      name: 'Impostor',
    });

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('bots_platform_bot_id_key');
      return true;
    });
  });

  it('refuses a status outside the tuple', async () => {
    const insert = db.execute(sql`
      insert into ${bots} (id, platform, bot_id, name, status)
      values ('bot-badstatus', 'telegram', 'tg-9', 'X', 'paused')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('bots_status_check');
      return true;
    });
  });
});

describe('a bot user is unique per bot, and goes with its bot', () => {
  it('refuses the same platform user twice on one bot', async () => {
    await db.insert(botUsers).values({
      id: 'bu-1',
      botId: 'bot-hook',
      platform: 'telegram',
      platformUserId: 'p1',
      chatId: 'c1',
    });

    const duplicate = db.insert(botUsers).values({
      id: 'bu-2',
      botId: 'bot-hook',
      platform: 'telegram',
      platformUserId: 'p1',
      chatId: 'c2',
    });

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('bot_users_bot_platform_user_key');
      return true;
    });
  });

  it('permits the same platform user on a DIFFERENT bot', async () => {
    // The uniqueness is per bot, not global — two bots may both be talking to
    // the same person, and each keeps its own row.
    await db
      .insert(bots)
      .values({ id: 'bot-other', platform: 'telegram', botId: 'tg-3', name: 'Other' });
    await db.insert(botUsers).values({
      id: 'bu-3',
      botId: 'bot-other',
      platform: 'telegram',
      platformUserId: 'p1',
      chatId: 'c3',
    });

    // Scoped to the two bots THIS FILE created. The count was unscoped —
    // `where platform_user_id = 'p1'` across the whole table — and several
    // `*.pgdb.test.ts` files share one database per run, so any sibling storing
    // a bot user called `p1` made this read its fixtures and fail for a reason
    // that named nothing. `botRepository.pgdb.test.ts` is the sibling that
    // surfaced it.
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${botUsers}
          where platform_user_id = 'p1' and bot_id in ('bot-hook', 'bot-other')`,
    );
    expect(rows[0]?.n).toBe('2');
  });

  it('takes its users when the bot is deleted', async () => {
    await db.delete(bots).where(eq(bots.id, 'bot-other'));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${botUsers} where bot_id = 'bot-other'`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});
