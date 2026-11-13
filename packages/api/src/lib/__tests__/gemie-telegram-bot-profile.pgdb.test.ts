import { TEST_CHARACTER } from '../../db/__tests__/support/agent-character';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

/**
 * A gemie bot's profile follows its gemie by itself (ADR 0037), against a REAL Postgres: the
 * debounce that coalesces an editor's autosaves, the sync that settles only what it saw, the photo
 * uploaded only when the look or the colour changed, and a failure kept for the editor and retried
 * with a backoff or after Telegram's `retry_after`. Telegram (through the integrations process) and
 * Oxy are faked; the rows are real.
 */

const telegram = vi.hoisted(() => ({
  calls: [] as Array<{ token: string; profile: Record<string, unknown> }>,
  answer: (): Record<string, unknown> => ({
    profile: { name: true, description: true, photo: true },
  }),
  /** Runs while the update is "in flight", to change the gemie meanwhile. */
  during: null as null | (() => Promise<void>),
}));
const identity = vi.hoisted(() => ({ name: 'Viajes' as string | null, color: 'blue' }));

vi.mock('../gemie-telegram-bot-setup.js', () => ({
  TelegramBotSetupError: class extends Error {},
  updateTelegramBotProfile: async (token: string, profile: Record<string, unknown>) => {
    // Other files' bots share the database: only this suite's are recorded.
    if (!token.endsWith('T'.repeat(35)))
      return { profile: { name: true, description: true, photo: true } };
    telegram.calls.push({ token, profile });
    if (telegram.during) await telegram.during();
    return telegram.answer();
  },
}));
vi.mock('../agent-identity.js', () => ({
  attachAgentIdentity: async (agent: object) => ({ ...agent, ...identity, handle: 'viajes' }),
  agentPromptName: (agent: { name: string | null }) => agent.name ?? 'Agent',
}));
vi.mock('../oxy.js', () => ({ oxy: {} }));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { agents } from '../../db/schema/agents.js';
import { bots } from '../../db/schema/bots.js';
import {
  gemieProfileChanged,
  PROFILE_DEBOUNCE_MS,
  profileBackoffMs,
  syncDueGemieBotProfiles,
} from '../gemie-telegram-bot-profile.js';

let db: ApiDatabase;
const SUITE = `botprofile-${process.pid}`;
let seq = 0;

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});
afterAll(async () => {
  await closePostgres();
});
beforeEach(() => {
  telegram.calls = [];
  telegram.during = null;
  telegram.answer = () => ({ profile: { name: true, description: true, photo: true } });
  identity.name = 'Viajes';
  identity.color = 'blue';
});

/** A gemie with its own bot, whose profile is already in step (as after a first sync). */
async function gemieWithBot(): Promise<{ agentId: string; botRowId: string }> {
  const agentId = `${SUITE}-agent-${seq++}`;
  await db.insert(agents).values({
    id: agentId,
    character: TEST_CHARACTER,
    oxyAccountId: `${SUITE}-account-${seq++}`,
    tagline: 'Plans your trips',
    description: 'A travel gemie.',
    authorOxyUserId: 'owner-1',
    category: 'general',
    status: 'active',
    systemPrompt: 'Be helpful.',
  });
  const [bot] = await db
    .insert(bots)
    .values({
      platform: 'telegram',
      botId: `${900000 + seq++}`,
      name: 'Viajes',
      username: 'viajes_bot',
      status: 'active',
      userId: 'owner-1',
      agentId,
      botToken: `${900000 + seq}:${'T'.repeat(35)}`,
    })
    .returning({ id: bots.id });
  if (!bot) throw new Error('bot not stored');
  return { agentId, botRowId: bot.id };
}

async function row(id: string) {
  const [found] = await db
    .select({
      dirtyAt: bots.profileDirtyAt,
      after: bots.profileSyncAfter,
      attempts: bots.profileSyncAttempts,
      error: bots.profileSyncError,
      photoKey: bots.profilePhotoKey,
    })
    .from(bots)
    .where(eq(bots.id, id));
  if (!found) throw new Error('no bot');
  return found;
}

/** Make a pending change due now, as if its debounce had passed. */
async function makeDue(id: string) {
  await db
    .update(bots)
    .set({ profileSyncAfter: new Date(Date.now() - 1) })
    .where(eq(bots.id, id));
}

describe('a gemie bot’s profile follows its gemie', () => {
  it('waits for the burst to end, then gives the bot the gemie’s name, description and photo', async () => {
    const { agentId, botRowId } = await gemieWithBot();
    // Three autosaves in a row are one change.
    await gemieProfileChanged(agentId);
    await gemieProfileChanged(agentId);
    await gemieProfileChanged(agentId);
    const pending = await row(botRowId);
    expect(pending.dirtyAt).not.toBeNull();
    expect(pending.after?.getTime()).toBeGreaterThan(Date.now() + PROFILE_DEBOUNCE_MS - 1000);

    // Not before its debounce.
    await syncDueGemieBotProfiles();
    expect(telegram.calls).toEqual([]);

    await makeDue(botRowId);
    await syncDueGemieBotProfiles();
    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0]?.profile).toEqual({
      name: 'Viajes',
      description: 'A travel gemie.',
      shortDescription: 'Plans your trips',
      photo: { character: TEST_CHARACTER, color: 'blue' },
    });
    const settled = await row(botRowId);
    expect(settled).toMatchObject({ dirtyAt: null, after: null, attempts: 0, error: null });
    expect(settled.photoKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uploads a photo again only when the look or the colour changed', async () => {
    const { agentId, botRowId } = await gemieWithBot();
    await gemieProfileChanged(agentId);
    await makeDue(botRowId);
    await syncDueGemieBotProfiles();

    identity.name = 'Viajes Pro';
    await gemieProfileChanged(agentId);
    await makeDue(botRowId);
    await syncDueGemieBotProfiles();
    expect(telegram.calls.at(-1)?.profile).toMatchObject({ name: 'Viajes Pro', photo: null });

    identity.color = '#ff8b67';
    await gemieProfileChanged(agentId);
    await makeDue(botRowId);
    await syncDueGemieBotProfiles();
    expect(telegram.calls.at(-1)?.profile).toMatchObject({
      photo: { character: TEST_CHARACTER, color: '#ff8b67' },
    });
  });

  it('keeps a failure for the editor and retries it later, after Telegram’s retry_after', async () => {
    const { agentId, botRowId } = await gemieWithBot();
    telegram.answer = () => ({
      profile: { name: false, description: true, photo: false },
      retryAfter: 120,
      error: 'Too Many Requests: retry after 120',
    });
    await gemieProfileChanged(agentId);
    await makeDue(botRowId);
    await syncDueGemieBotProfiles();
    const failed = await row(botRowId);
    expect(failed.error).toBe('Too Many Requests: retry after 120');
    expect(failed.attempts).toBe(1);
    expect(failed.dirtyAt).not.toBeNull();
    expect(failed.after?.getTime()).toBeGreaterThan(Date.now() + 110_000);

    // Not again before then.
    await syncDueGemieBotProfiles();
    expect(telegram.calls).toHaveLength(1);

    // Telegram takes it the next time: the failure is gone.
    telegram.answer = () => ({ profile: { name: true, description: true, photo: true } });
    await makeDue(botRowId);
    await syncDueGemieBotProfiles();
    expect(await row(botRowId)).toMatchObject({ dirtyAt: null, error: null, attempts: 0 });
  });

  it('backs off longer each time Telegram cannot be reached, up to an hour', () => {
    expect(profileBackoffMs(0)).toBe(15_000);
    expect(profileBackoffMs(1)).toBe(30_000);
    expect(profileBackoffMs(20)).toBe(60 * 60_000);
  });

  it('does not write a stand-in name when Oxy cannot be asked', async () => {
    const { agentId, botRowId } = await gemieWithBot();
    identity.name = null;
    await gemieProfileChanged(agentId);
    await makeDue(botRowId);
    await syncDueGemieBotProfiles();
    expect(telegram.calls).toEqual([]);
    expect((await row(botRowId)).error).toContain('Oxy');
  });

  it('leaves a change made while it synced for the next run', async () => {
    const { agentId, botRowId } = await gemieWithBot();
    await gemieProfileChanged(agentId);
    await makeDue(botRowId);
    telegram.during = async () => {
      telegram.during = null;
      await gemieProfileChanged(agentId);
    };
    await syncDueGemieBotProfiles();
    const after = await row(botRowId);
    expect(after.dirtyAt).not.toBeNull();
    expect(after.error).toBeNull();
  });

  it('keeps a token it cannot read as that bot’s failure, and syncs the others', async () => {
    const unreadable = await gemieWithBot();
    const readable = await gemieWithBot();
    await db.execute(
      sql`UPDATE bots SET bot_token = 'not:a:token' WHERE id = ${unreadable.botRowId}`,
    );
    await gemieProfileChanged(unreadable.agentId);
    await gemieProfileChanged(readable.agentId);
    await makeDue(unreadable.botRowId);
    await makeDue(readable.botRowId);
    await syncDueGemieBotProfiles();
    expect((await row(unreadable.botRowId)).error).toMatch(/cannot be read/);
    expect(await row(readable.botRowId)).toMatchObject({ dirtyAt: null, error: null });
  });
});
