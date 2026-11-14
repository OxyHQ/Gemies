import { TEST_CHARACTER } from '../../db/__tests__/support/agent-character';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';

/**
 * The two inbound chat handlers — the system bot's (`routes/webhooks.ts`) and a
 * gemie's own Telegram bot's (`lib/gemie-telegram-bot.ts`) — against a REAL
 * Postgres server, for one property: **the reservation is charged or given
 * back, never neither.**
 *
 * ## What was wrong, and why nothing reported it
 *
 * Both handlers reserve a credit before they do anything, then walk a series of
 * exits that answer a problem by messaging the user and returning — no model
 * available, an exception anywhere — and none of them gave the credit back. A
 * person whose message arrived while every model was down was charged for the
 * apology.
 *
 * These handlers are fire-and-forget from the route: it acks the platform and
 * drops the promise. So there is no status code to assert and no caller to
 * observe. The balance is the only thing that records what happened, which is
 * both why the leak survived and why every case here reads it.
 *
 * ## The model layer is stubbed; the credits are not
 *
 * `resolveStoredModel` and `generateText` stand for the outside world and are the two
 * things being made to fail. `reserveCredits`, `finalizeCredits` and
 * `refundReservation` run for real against the real table.
 */

vi.mock('@oxy.so/core/server', () => ({ verifySecret: vi.fn(() => false) }));
// Background product credits read `lib/oxy.ts` only when a product adapter is
// configured, which this file never does; the real module would construct an
// OxyServer at import time.
vi.mock('../../lib/oxy.js', () => ({ oxy: {} }));
vi.mock('../../lib/kaana/transport.js', () => ({ getKaanaClient: () => null }));
// A voice note is transcribed on the dictation path; here, its words.
vi.mock('../../lib/voice/transcribe.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  transcribeDictation: vi.fn(async () => ({ text: 'hola, ¿quedamos mañana?', model: 'stt' })),
}));
// A channel message's media is kept as the person's Oxy file; here, an id.
vi.mock('../../lib/files/oxy-files.js', () => ({
  storeChannelMedia: vi.fn(async () => 'oxy-file-1'),
}));
vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({
    text: 'an answer',
    usage: { inputTokens: 10, outputTokens: 10 },
    steps: [{ toolResults: [] }],
  })),
  stepCountIs: vi.fn(() => 5),
  tool: vi.fn((definition: unknown) => definition),
}));
vi.mock('../../lib/channels/registry.js', () => ({ getChannel: vi.fn(() => null) }));
// The ONE assembler stands in for what `buildChatTools` used to: this file is
// about credit reservation on an inbound bot message, not about which tools a
// bot turn gets, and the real pipeline imports every tool module behind it.
vi.mock('../../lib/tool-pipeline.js', () => ({
  ToolPipeline: { forUser: vi.fn(async () => ({ tools: {}, toolNameMapping: new Map() })) },
}));
vi.mock('../../lib/agent-identity.js', () => ({
  attachAgentIdentity: vi.fn(async (agent: unknown) => agent),
  agentPromptName: vi.fn(() => 'Agent'),
}));
vi.mock('../../lib/channels/outbound.js', () => ({
  sendChannelMessage: vi.fn(async () => undefined),
}));
vi.mock('../../lib/prompt-loader.js', () => ({ loadPrompt: vi.fn(async () => 'be helpful') }));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      webhook: child,
      general: child,
      agents: child,
      chat: child,
      credits: child,
      v1: child,
      providers: child,
      channels: child,
    },
  };
});
vi.mock('../../lib/chat-core.js', () => ({
  resolveStoredModel: vi.fn(async () => ({
    provider: 'kaana',
    modelId: 'acme/stub-1',
    oxyInferenceTarget: { kind: 'model', model: 'acme/stub-1' },
  })),
  getAIModel: vi.fn(() => ({})),
}));

import { generateText } from 'ai';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { agents } from '../../db/schema/agents.js';
import { userCredits } from '../../db/schema/billing.js';
import { messages } from '../../db/schema/chat.js';
import { getOrCreateUserCredits } from '../../db/billing/userCreditsRepository.js';
import { resolveStoredModel } from '../../lib/chat-core.js';
import type { BotUserRow } from '../../db/integrations/botRepository.js';
import type { GemieBotRow } from '../../db/integrations/gemieBotRepository.js';
import type { ChannelInboundMessage } from '../../lib/channels/types.js';
import { storeChannelMedia } from '../../lib/files/oxy-files.js';
import { answerGemieTelegramMessage } from '../../lib/gemie-telegram-bot.js';
import type { GemieTelegramBotMessage } from '@gemies/server/internal';
import { processChannelMessage } from '../webhooks.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Namespaced by pid — several `*.pgdb.test.ts` files share ONE database. */
const SUITE = `webhook-${process.pid}`;
let seq = 0;

async function account(free: number, paid: number): Promise<string> {
  const id = `${SUITE}-${seq++}`;
  await getOrCreateUserCredits(db, id);
  await db
    .update(userCredits)
    .set({ creditsFree: free, creditsPaid: paid })
    .where(eq(userCredits.id, id));
  return id;
}

async function balanceOf(id: string): Promise<{ free: number; paid: number }> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
}

const message: ChannelInboundMessage = {
  platformUserId: 'tg-1',
  chatId: 'chat-1',
  text: 'hello there',
};

function linkedBotUser(oxyUserId: string): BotUserRow {
  return {
    id: `${SUITE}-botuser-${seq++}`,
    botId: `${SUITE}-bot`,
    platform: 'discord',
    platformUserId: 'tg-1',
    chatId: 'chat-1',
    oxyUserId,
    isLinked: true,
    oxyTaskId: null,
    oxyTaskState: 'reauth_required',
    linkedAt: new Date(),
    username: null,
    displayName: null,
    authTokenExpiry: null,
    authTokenMode: null,
    // Set, so nothing has to write one to a row this fixture never inserted.
    conversationId: `${SUITE}-conv-${seq++}`,
    preferredModel: 'acme/stub-1',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const botMessage: GemieTelegramBotMessage = {
  chatId: 'chat-1',
  chatKind: 'direct',
  chatTitle: null,
  messageId: '1',
  from: { id: 'tg-1', username: null, name: 'A stranger' },
  message: { text: 'hello there' },
  mentionsBot: false,
};

/**
 * A gemie's own Telegram bot, on a fresh gemie.
 *
 * `ownerPaysAgentTurns` defaults to true, so the first cases assert that the
 * person who connected it pays. `agentAccountId` defaults to an account with NO
 * balance row, which is what every gemie has unless someone funded it.
 */
async function gemieBot(
  ownerUserId: string,
  opts: { ownerPaysAgentTurns?: boolean; agentAccountId?: string } = {},
): Promise<GemieBotRow> {
  const agentId = `${SUITE}-agent-${seq++}`;
  await db.insert(agents).values({
    id: agentId,
    character: TEST_CHARACTER,
    oxyAccountId: opts.agentAccountId ?? `${SUITE}-agent-account-${seq++}`,
    tagline: 'a webhook fixture agent',
    description: 'seeded for the webhook credit suite',
    authorOxyUserId: ownerUserId,
    category: 'general',
    status: 'active',
    systemPrompt: 'Be helpful.',
  });
  return {
    id: `${SUITE}-bot-${seq++}`,
    botId: `${seq++}`,
    agentId,
    userId: ownerUserId,
    name: 'Helper',
    username: 'helper_bot',
    status: 'active',
    groupReplies: 'mentions',
    ownerPaysAgentTurns: opts.ownerPaysAgentTurns ?? true,
    linkedTelegramUserId: null,
    linkedTelegramName: null,
    oxyTaskId: null,
    totalMessages: 0,
    lastMessageAt: null,
    profileSyncError: null,
    createdAt: new Date(),
  };
}

describe('processChannelMessage — the system bot', () => {
  it('charges the turn when it answers', async () => {
    const userId = await account(100, 0);

    await processChannelMessage('discord', linkedBotUser(userId), message);

    // The positive control. 20 tokens settles at the 1-credit minimum, which is
    // exactly what was reserved — so a handler that refunded unconditionally
    // would fail here and pass everything below.
    expect(await balanceOf(userId)).toEqual({ free: 99, paid: 0 });
  });

  it('gives the credit back when NO MODEL can be resolved', async () => {
    const userId = await account(100, 0);
    vi.mocked(resolveStoredModel).mockRejectedValueOnce(new Error('no model'));

    await processChannelMessage('discord', linkedBotUser(userId), message);

    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  it('gives the credit back when the model call THROWS', async () => {
    const userId = await account(100, 0);
    vi.mocked(generateText).mockRejectedValueOnce(new Error('every provider is down'));

    await processChannelMessage('discord', linkedBotUser(userId), message);

    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  it('gives a paid-funded credit back to the PAID balance', async () => {
    const userId = await account(0, 100);
    vi.mocked(resolveStoredModel).mockRejectedValueOnce(new Error('no model'));

    await processChannelMessage('discord', linkedBotUser(userId), message);

    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });
});

describe('a gemie’s own Telegram bot', () => {
  it("charges the OWNER's turn when it answers", async () => {
    const ownerId = await account(100, 0);

    await answerGemieTelegramMessage(await gemieBot(ownerId), botMessage).catch(() => null);

    expect(await balanceOf(ownerId)).toEqual({ free: 99, paid: 0 });
  });

  it("gives the OWNER's credit back when NO MODEL can be resolved", async () => {
    const ownerId = await account(100, 0);
    vi.mocked(resolveStoredModel).mockRejectedValueOnce(new Error('no model'));

    await answerGemieTelegramMessage(await gemieBot(ownerId), botMessage).catch(() => null);

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });

  it("gives the OWNER's credit back when the model call THROWS", async () => {
    const ownerId = await account(100, 0);
    vi.mocked(generateText).mockRejectedValueOnce(new Error('every provider is down'));

    await answerGemieTelegramMessage(await gemieBot(ownerId), botMessage).catch(() => null);

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });
});

/**
 * Who pays for an agent-bot turn: `reserveAgentTurn`, wired.
 *
 * Every case reads BOTH balances — the agent's and the owner's — and names the
 * one that must not have moved, for the reason `turn-funding.pgdb.test.ts`
 * gives: a double debit looks exactly like the right answer from either side
 * alone.
 */
describe("a gemie’s own Telegram bot — who pays for the gemie's turn", () => {
  async function rowExists(id: string): Promise<boolean> {
    const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
    return row !== undefined;
  }

  it('charges the AGENT when its own (owner-funded) balance covers it, and leaves the owner alone', async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = await account(0, 20);

    await answerGemieTelegramMessage(await gemieBot(ownerId, { agentAccountId }), botMessage).catch(
      () => null,
    );

    expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 19 });
    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });

  it("gives the AGENT's credit back, not the owner's, when the model call throws", async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = await account(0, 20);
    vi.mocked(generateText).mockRejectedValueOnce(new Error('every provider is down'));

    await answerGemieTelegramMessage(await gemieBot(ownerId, { agentAccountId }), botMessage).catch(
      () => null,
    );

    expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 20 });
    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });

  it('falls to the OWNER when the agent has no balance and the owner consented — and never provisions the agent', async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = `${SUITE}-unfunded-agent-${seq++}`;

    await answerGemieTelegramMessage(
      await gemieBot(ownerId, { agentAccountId, ownerPaysAgentTurns: true }),
      botMessage,
    ).catch(() => null);

    expect(await balanceOf(ownerId)).toEqual({ free: 99, paid: 0 });
    // The free-credit farm stays shut: running a turn gave the agent no row.
    expect(await rowExists(agentAccountId)).toBe(false);
  });

  it('refuses, charging NOBODY and calling no model, when the owner has not consented', async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = await account(0, 0);
    vi.mocked(generateText).mockClear();

    const { reply: text } = await answerGemieTelegramMessage(
      await gemieBot(ownerId, { agentAccountId, ownerPaysAgentTurns: false }),
      botMessage,
    );

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
    expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 0 });
    expect(generateText).not.toHaveBeenCalled();
    // The stranger is told it is a PERMISSION, not a balance.
    expect(text).toContain('has not allowed it to use their credits');
    expect(text).not.toContain('out of credits');
  });

  it('refuses with the out-of-credits message when neither balance covers it', async () => {
    const ownerId = await account(0, 0);
    vi.mocked(generateText).mockClear();

    const { reply: text } = await answerGemieTelegramMessage(
      await gemieBot(ownerId, { ownerPaysAgentTurns: true }),
      botMessage,
    );

    expect(await balanceOf(ownerId)).toEqual({ free: 0, paid: 0 });
    expect(generateText).not.toHaveBeenCalled();
    expect(text).toContain('out of credits');
  });
});

describe('what a gemie bot’s conversation keeps of a message', () => {
  it('shows a stranger’s sticker to the gemie, keeps it in words only, and follows an edit without answering', async () => {
    const ownerId = await account(100, 0);
    const bot = await gemieBot(ownerId);
    const sticker: GemieTelegramBotMessage = {
      ...botMessage,
      messageId: '77',
      message: {
        text: '',
        media: [
          {
            kind: 'sticker',
            emoji: '😂',
            setName: 'HappyCats',
            file: { mime: 'image/webp', data: Buffer.from('webp').toString('base64') },
          },
        ],
      },
    };
    vi.mocked(generateText).mockClear();

    const answer = await answerGemieTelegramMessage(bot, sticker);

    expect(answer.reply).toBe('an answer');
    const stored = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.oxyUserId, ownerId))
      // In the order they were kept: the message when it arrived, then the answer.
      .orderBy(asc(messages.seq));
    // A third party's media is never stored as the bot person's file: the person's authority is
    // for their own turns (`docs/integrations.mdx`), so the conversation keeps its words.
    expect(storeChannelMedia).not.toHaveBeenCalled();
    expect(stored).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[Sticker 😂 from the set "HappyCats"]' }],
      },
      { role: 'assistant', content: 'an answer' },
    ]);
    // The gemie saw the sticker itself.
    const [call] = vi.mocked(generateText).mock.calls;
    const sent = (call?.[0] as { messages: Array<{ content: unknown }> }).messages.at(-1);
    expect(sent?.content).toEqual([
      { type: 'text', text: '[Sticker 😂 from the set "HappyCats"]' },
      { type: 'image', image: expect.any(Uint8Array), mediaType: 'image/webp' },
    ]);

    vi.mocked(generateText).mockClear();
    const edit = await answerGemieTelegramMessage(bot, {
      ...sticker,
      message: { text: 'jaja', media: [{ kind: 'sticker', emoji: '😂', setName: 'HappyCats' }] },
      edited: true,
    });
    expect(edit).toEqual({ reply: null });
    expect(generateText).not.toHaveBeenCalled();
    const [edited] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.oxyUserId, ownerId), eq(messages.role, 'user')));
    expect(edited?.content).toEqual([
      { type: 'text', text: '[Sticker 😂 from the set "HappyCats"]\njaja' },
    ]);
  });
});

describe('a message’s turn on a gemie bot runs once, whatever is retried', () => {
  it('a retry while it runs waits for it, and one after it gets the same answer', async () => {
    const ownerId = await account(100, 0);
    const bot = await gemieBot(ownerId);
    const message: GemieTelegramBotMessage = { ...botMessage, messageId: '501' };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(generateText).mockClear();
    vi.mocked(generateText).mockImplementationOnce(async () => {
      await gate;
      return {
        text: 'the only answer',
        usage: { inputTokens: 10, outputTokens: 10 },
        steps: [{ toolResults: [] }],
      } as never;
    });

    // The first attempt runs; the integrations process gave up on it and retries meanwhile.
    const first = answerGemieTelegramMessage(bot, message);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const retry = answerGemieTelegramMessage(bot, message);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();

    expect(await first).toMatchObject({ reply: 'the only answer' });
    expect(await retry).toMatchObject({ reply: 'the only answer' });
    // A later retry (its answer never reached Telegram) gets it again, without another turn.
    expect(await answerGemieTelegramMessage(bot, message)).toMatchObject({
      reply: 'the only answer',
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    // One turn charged, and one exchange kept.
    expect(await balanceOf(ownerId)).toEqual({ free: 99, paid: 0 });
    const kept = await db
      .select({ role: messages.role })
      .from(messages)
      .where(eq(messages.oxyUserId, ownerId));
    expect(kept.map((row) => row.role).sort()).toEqual(['assistant', 'user']);
  });

  it('a turn that failed keeps its apology, so a retry says it rather than run it again', async () => {
    const ownerId = await account(100, 0);
    const bot = await gemieBot(ownerId);
    const message: GemieTelegramBotMessage = { ...botMessage, messageId: '502' };
    vi.mocked(generateText).mockClear();
    vi.mocked(generateText).mockRejectedValueOnce(new Error('No available route'));
    await expect(answerGemieTelegramMessage(bot, message)).rejects.toThrow('No available route');
    expect(await answerGemieTelegramMessage(bot, message)).toEqual({
      reply: 'Sorry, something went wrong. Please try again.',
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

describe('a gemie bot’s person sends media: kept at once, and read on the turn without failing it', () => {
  it('a sticker, a photo and a voice note reach the conversation the moment they arrive', async () => {
    const ownerId = await account(100, 0);
    const bot: GemieBotRow = {
      ...(await gemieBot(ownerId)),
      linkedTelegramUserId: 'tg-1',
      oxyTaskId: 'bot-task',
    };
    let n = 0;
    vi.mocked(storeChannelMedia).mockImplementation(async () => `kept-${(n += 1)}`);
    const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
    const answer = await answerGemieTelegramMessage(bot, {
      ...botMessage,
      messageId: '901',
      message: {
        text: '',
        media: [
          { kind: 'sticker', emoji: '😂', file: { mime: 'image/webp', data: b64([1, 2, 3]) } },
          { kind: 'photo', file: { mime: 'image/jpeg', data: b64([0xff, 0xd8, 0xff]) } },
          { kind: 'voice', durationSeconds: 4, file: { mime: 'audio/ogg', data: b64([79, 103]) } },
        ],
      },
    });

    // The person's own turn, run by the chat route: what it carries is what the app will show.
    expect(answer.personTurn?.content).toEqual([
      expect.objectContaining({
        type: 'file',
        file: expect.objectContaining({ file_id: 'kept-1', kind: 'sticker' }),
      }),
      expect.objectContaining({
        type: 'file',
        file: expect.objectContaining({ file_id: 'kept-2', kind: 'photo' }),
      }),
      expect.objectContaining({
        type: 'file',
        file: expect.objectContaining({
          file_id: 'kept-3',
          kind: 'voice',
          transcript: 'hola, ¿quedamos mañana?',
        }),
      }),
    ]);
    // Kept before any answer, so the app shows it at once.
    const kept = await db
      .select({ role: messages.role, content: messages.content, id: messages.clientMessageId })
      .from(messages)
      .where(eq(messages.oxyUserId, ownerId));
    expect(kept).toEqual([
      { role: 'user', content: answer.personTurn?.content, id: 'telegram:chat-1:901' },
    ]);

    // The chat route reads each file as a channel's: none can fail the turn (Oxy cannot answer
    // here, so each is said in words).
    const { filePartsOf, resolveFileParts } = await import('../../lib/files/person-files.js');
    const resolved = await resolveFileParts(
      filePartsOf([{ role: 'user', content: answer.personTurn?.content as never }]),
      {
        personAccountId: ownerId,
        accessToken: undefined,
        taskId: 'bot-task',
        modelAcceptsFiles: false,
        channel: true,
      },
    );
    expect(resolved.get('kept-1')).toEqual([
      { type: 'text', text: '[Sticker 😂; it could not be opened]' },
    ]);
    expect(resolved.get('kept-3')).toEqual([
      { type: 'text', text: '[Voice note, 0:04. It says: hola, ¿quedamos mañana?]' },
    ]);
    vi.mocked(storeChannelMedia).mockImplementation(async () => 'oxy-file-1');
  });
});
