/**
 * Whose turn a message to a gemie's own Telegram bot is (ADR 0037 and its amendment), and what the
 * model is handed for it.
 *
 * The production bug this pins: the person who connected Eusebio's bot asked it, from their own
 * Telegram, "¿qué hay en mi email?" and got "no tengo acceso", because every bot turn ran as nobody
 * (no person, no task) and nothing told the bot which Telegram account was its person's.
 *
 *  - The bot's person, in private, from the Telegram account they linked: `personTurn`, which the
 *    integrations process runs through `/alia/chat` like any of their turns in the app.
 *  - Anybody else — a stranger, an unlinked person, the person in a group, a link without its
 *    task — is a third party: the turn runs here with the REAL assembler, and what reaches the model
 *    is checked against the gemie's public tools. The bulk sources (connectors, Oxy apps, agents)
 *    are stubbed and must not even be asked.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import type { GemieTelegramBotMessage } from '@gemies/server/internal';
import { personaGemie } from '../../__tests__/support/gemies.js';
import type { GemieBotRow } from '../../db/integrations/gemieBotRepository.js';

const state = vi.hoisted(() => ({
  asked: { mcp: 0, oxy: 0, agent: 0 },
  model: [] as Array<{ system: string; tools: Record<string, unknown> }>,
  claim: vi.fn(),
  appended: [] as unknown[],
  storedMedia: vi.fn(async (_input: { oxyUserId: string; taskId: string }) => 'kept-file'),
}));

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../files/oxy-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../files/oxy-files.js')>()),
  storeChannelMedia: state.storedMedia,
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      agents: child,
      chat: child,
      general: child,
      v1: child,
      providers: child,
      tools: child,
      channels: child,
    },
  };
});
vi.mock('../tools/mcp.js', () => ({
  buildMcpTools: vi.fn(async () => {
    state.asked.mcp += 1;
    return { mcp_inbox__read: { description: 'private' } };
  }),
}));
vi.mock('../tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async () => {
    state.asked.oxy += 1;
    return { oxy_inbox__listMessages: { description: 'private' } };
  }),
}));
vi.mock('../tools/consult-agent.js', () => ({
  buildConsultAgentTool: vi.fn(async () => {
    state.asked.agent += 1;
    return { consultAgent: { description: 'private' } };
  }),
}));
vi.mock('../../db/integrations/connectedAccountRepository.js', () => ({
  // Granted to the gemie: a third party still must not get them.
  listAccountsGrantedTo: vi.fn(async () => [
    {
      id: 'wa-1',
      platform: 'whatsapp',
      sessionId: 'wa-session',
      status: 'connected',
      answers: false,
      phoneNumber: '+34600',
      displayName: null,
      createdAt: new Date(1),
    },
  ]),
}));
vi.mock('../../db/spaces/spaceRepository.js', () => ({ listSpacePeerIds: vi.fn(async () => []) }));
vi.mock('../../db/agents/agentRepository.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findAgentById: vi.fn(async () =>
    personaGemie({
      _id: 'gemie-1',
      id: 'gemie-1',
      name: 'Eusebio',
      ownerOxyAccountId: 'owner-1',
      capabilityGrants: ['web', 'memory', 'automation', 'artifacts', 'computer', 'delegation'],
    }),
  ),
}));
vi.mock('../agent-identity.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachAgentIdentity: vi.fn(async (agent: object) => agent),
}));
vi.mock('../chat-core.js', () => ({
  resolveStoredModel: vi.fn(async () => ({ modelId: 'm', catalogue: null })),
  getAIModel: vi.fn(() => ({})),
}));
vi.mock('../chat/tool-synthesis.js', () => ({
  generateAnswered: vi.fn(async (input: { system: string; tools: Record<string, unknown> }) => {
    state.model.push({ system: input.system, tools: input.tools });
    return {
      text: 'Hola',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      last: {},
    };
  }),
}));
vi.mock('../agent/turn-funding.js', () => ({
  reserveAgentTurn: vi.fn(async () => ({ ok: true, reservation: { id: 'r' } })),
}));
vi.mock('../credits-manager.js', () => ({
  finalizeCredits: vi.fn(async () => undefined),
  safeRefund: vi.fn(async () => undefined),
}));
vi.mock('../user-credits-helpers.js', () => ({ getOrCreateUserCredits: vi.fn(async () => ({})) }));
vi.mock('../../db/chat/messageRepository.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listRecentTurns: vi.fn(async () => []),
}));
vi.mock('../conversation-saver.js', () => ({
  appendConversationMessages: vi.fn(async (input: unknown) => {
    state.appended.push(input);
  }),
}));
vi.mock('../../db/integrations/gemieBotRepository.js', () => ({
  claimGemieBotLinkCode: state.claim,
  recordGemieBotMessage: vi.fn(async () => undefined),
  // Each message's turn is this attempt's: the run-once claim is `gemie-bot-turns.pgdb.test.ts`'s.
  claimGemieBotTurn: vi.fn(async () => ({ kind: 'claimed' })),
  readGemieBotTurn: vi.fn(async () => ({ kind: 'running' })),
  settleGemieBotTurn: vi.fn(async () => undefined),
}));

const { answerGemieTelegramMessage } = await import('../gemie-telegram-bot.js');

/** What the gemie's own, public turn may hold: nothing that reaches anybody's data. */
const PUBLIC_TOOLS = new Set([
  'getCurrentDate',
  'generateFile',
  'canvas',
  'webSearch',
  'webScraper',
  'getWeather',
  'getMarketQuote',
  'getFairCoin',
  // Reacting to the message it answers reaches nothing of anybody's.
  'reactToMessage',
  // Says how the person's apps become reachable here; reaches nothing itself.
  'personalAppsAccess',
]);

const PERSON = '570038640';

function bot(over: Partial<GemieBotRow> = {}): GemieBotRow {
  return {
    id: 'row-1',
    botId: '8988966019',
    agentId: 'gemie-1',
    userId: 'owner-1',
    name: 'Eusebio',
    username: 'EusebioOxyBot',
    status: 'active',
    groupReplies: 'mentions',
    ownerPaysAgentTurns: true,
    linkedTelegramUserId: PERSON,
    oxyTaskId: 'bot-task',
    totalMessages: 0,
    lastMessageAt: null,
    profileSyncError: null,
    createdAt: new Date(),
    ...over,
  };
}

let sender = 0;
function message(
  over: Partial<GemieTelegramBotMessage> & { text?: string } = {},
): GemieTelegramBotMessage {
  const from = over.from ?? { id: PERSON, username: 'NateIsern', name: 'Nate' };
  const { text = '¿Qué hay en mi email?', ...rest } = over;
  return {
    chatId: from.id,
    chatKind: 'direct',
    chatTitle: null,
    messageId: `m-${Date.now()}-${Math.random()}`,
    message: { text },
    mentionsBot: false,
    ...rest,
    from,
  };
}

/** A different sender per call, so the per-sender rate limit never colours a result. */
function stranger(): GemieTelegramBotMessage['from'] {
  sender += 1;
  return { id: String(9_000_000 + sender), username: null, name: 'Someone' };
}

function expectThirdPartyTurn() {
  expect(state.model).toHaveLength(1);
  const handed = Object.keys(state.model[0]!.tools as ToolSet);
  expect(handed.filter((name) => !PUBLIC_TOOLS.has(name))).toEqual([]);
  // Not even asked: a source that is not fetched cannot leak.
  expect(state.asked).toEqual({ mcp: 0, oxy: 0, agent: 0 });
  // Honest about why, and how the person changes it: from a tool, not a sentence it may ignore.
  expect(state.model[0]!.system).toContain('call personalAppsAccess');
  expect(handed).toContain('personalAppsAccess');
}

beforeEach(() => {
  state.asked = { mcp: 0, oxy: 0, agent: 0 };
  state.model = [];
  state.appended = [];
  state.claim.mockReset();
  state.storedMedia.mockClear();
});

const PHOTO = {
  text: '',
  media: [
    {
      kind: 'photo' as const,
      file: { mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
    },
  ],
};

describe('media sent to the bot', () => {
  it('from its person, in private, is kept as theirs under the task they granted the gemie there', async () => {
    const answer = await answerGemieTelegramMessage(bot(), { ...message(), message: PHOTO });
    expect(state.storedMedia).toHaveBeenCalledTimes(1);
    expect(state.storedMedia.mock.calls[0]?.[0]).toMatchObject({
      oxyUserId: 'owner-1',
      taskId: 'bot-task',
    });
    expect(answer.personTurn?.content).toContainEqual(
      expect.objectContaining({
        type: 'file',
        file: expect.objectContaining({ file_id: 'kept-file' }),
      }),
    );
  });

  it('from anybody else is never stored as the person’s: their authority is for their own turns', async () => {
    await answerGemieTelegramMessage(bot(), { ...message({ from: stranger() }), message: PHOTO });
    expect(state.storedMedia).not.toHaveBeenCalled();
    expect(state.model).toHaveLength(1);
  });
});

describe('the person who connected the bot', () => {
  it('writing in private from their linked Telegram, gets their own turn, as in the app', async () => {
    const sent = message();
    expect(await answerGemieTelegramMessage(bot(), sent)).toEqual({
      reply: null,
      personTurn: {
        conversationId: `telegram:8988966019:${PERSON}`,
        // Stored under the Telegram message, so an edit finds it again.
        messageId: `telegram:${PERSON}:${sent.messageId}`,
        content: [{ type: 'text', text: '¿Qué hay en mi email?' }],
      },
    });
    // Nothing ran here: their turn is the chat route's.
    expect(state.model).toEqual([]);
  });

  it('is still a third party in a group, where everybody reads the answer', async () => {
    const answer = await answerGemieTelegramMessage(
      bot(),
      message({ chatId: '-100', chatKind: 'group', chatTitle: 'Family', mentionsBot: true }),
    );
    expect(answer).toEqual({ reply: 'Hola', reaction: null });
    expectThirdPartyTurn();
  });

  it('before linking, or with the authority revoked, is a third party like anyone', async () => {
    await answerGemieTelegramMessage(bot({ linkedTelegramUserId: null }), message());
    expectThirdPartyTurn();
    state.model = [];
    await answerGemieTelegramMessage(bot({ oxyTaskId: null }), message({ messageId: 'x2' }));
    expect(state.model).toHaveLength(1);
  });
});

describe('a stranger on the bot', () => {
  it('never gets anything private: no Oxy apps, connectors, accounts, memory or tasks', async () => {
    const answer = await answerGemieTelegramMessage(bot(), message({ from: stranger() }));
    expect(answer).toEqual({ reply: 'Hola', reaction: null });
    expect(answer.personTurn).toBeUndefined();
    expectThirdPartyTurn();
    // Kept in the person's conversation for that chat, as the gemie's own exchange.
    expect(state.appended[0]).toMatchObject({ userId: 'owner-1', source: 'telegram' });
  });

  it('cannot become the person by claiming their Telegram id in a group', async () => {
    const answer = await answerGemieTelegramMessage(
      bot(),
      message({ chatId: '-100', chatKind: 'group', mentionsBot: true }),
    );
    expect(answer.personTurn).toBeUndefined();
  });
});

describe('linking a Telegram account', () => {
  it('an unlinked sender who starts the bot is told how to link', async () => {
    const answer = await answerGemieTelegramMessage(
      bot({ linkedTelegramUserId: null }),
      message({ text: '/start' }),
    );
    expect(answer.reply).toContain('link your Telegram');
    expect(answer.reply).toContain('Eusebio › Telegram bot › Link my Telegram');
    expect(state.model).toEqual([]);
  });

  it('in their language when Telegram says it', async () => {
    const answer = await answerGemieTelegramMessage(
      bot({ linkedTelegramUserId: null }),
      message({ text: '/start', from: { ...stranger(), languageCode: 'es' } }),
    );
    expect(answer.reply).toContain('Vincular mi Telegram');
  });

  it('redeems the editor’s one-time code for the Telegram account that opened it', async () => {
    const code = 'A'.repeat(32);
    state.claim.mockResolvedValueOnce(bot());
    const from = { ...stranger(), languageCode: 'es' };
    const answer = await answerGemieTelegramMessage(
      bot({ linkedTelegramUserId: null }),
      message({ text: `/start ${code}`, from }),
    );
    expect(state.claim).toHaveBeenCalledWith(
      {},
      {
        botId: '8988966019',
        // Only its hash is ever compared: the table never holds a usable code.
        codeHash: createHash('sha256').update(code).digest('hex'),
        telegramUserId: from.id,
      },
    );
    expect(answer.reply).toMatch(/^Vinculado\./);
  });

  it('says so when a code is not good, and never links by it', async () => {
    state.claim.mockResolvedValueOnce(null);
    const answer = await answerGemieTelegramMessage(
      bot({ linkedTelegramUserId: null }),
      message({ text: `/start ${'B'.repeat(32)}`, from: stranger() }),
    );
    expect(answer.reply).toMatch(/expired or was already used/);
    expect(answer.personTurn).toBeUndefined();
  });

  it('takes a code only in private', async () => {
    await answerGemieTelegramMessage(
      bot(),
      message({
        text: `/start ${'C'.repeat(32)}`,
        chatKind: 'group',
        mentionsBot: true,
        chatId: '-1',
      }),
    );
    expect(state.claim).not.toHaveBeenCalled();
  });
});

describe('asked for its person’s apps in a turn that cannot reach them', () => {
  type Tools = Record<string, { execute: (input: unknown, options: unknown) => Promise<string> }>;
  const access = async (botOver: Partial<GemieBotRow>, over: Partial<GemieTelegramBotMessage>) => {
    state.model = [];
    await answerGemieTelegramMessage(
      bot(botOver),
      message({ text: '¿Qué hay en mi email?', ...over }),
    );
    const tools = state.model[0]?.tools as unknown as Tools;
    return tools.personalAppsAccess.execute({ asked: 'email' }, {});
  };

  it('says how its person links their Telegram while nobody has, never that it cannot', async () => {
    const said = await access(
      { linkedTelegramUserId: null, oxyTaskId: null },
      { from: { ...stranger(), languageCode: 'es' } },
    );
    expect(said).toContain('once its person links their Telegram');
    expect(said).toContain('Vincular mi Telegram');
    expect(state.model[0]?.system).toContain('never say the capability does not exist');
  });

  it('tells anyone else on a linked bot that only its person, in private, can', async () => {
    expect(await access({}, { from: stranger() })).toContain('This sender is not that account');
  });

  it('in a group, says never there', async () => {
    expect(
      await access({}, { chatKind: 'group', mentionsBot: true, chatId: '-1', chatTitle: 'Team' }),
    ).toContain('In a group');
  });
});
