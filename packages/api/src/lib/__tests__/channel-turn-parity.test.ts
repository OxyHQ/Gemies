/**
 * A person's turn has the same capabilities wherever it comes from (ADR 0037, amendment).
 *
 * The real assembler, called twice with exactly what `routes/v1/chat-completions.ts` passes it: once
 * for the person in the app (their bearer), once for the same person writing to their gemie's bot
 * from the Telegram they linked (a verified `gemie_bot` channel: no bearer, the standing task they
 * granted the gemie). The bulk sources are stubbed (their rows are in a database this test lacks);
 * what each was ASKED with is the observation.
 *
 * The only tools allowed to differ are the ones whose precondition is structurally the app's — a
 * live Oxy bearer to mint an agent under, a client that draws a card — and they are named here, so
 * a new difference is a red test, not a quiet reduced tool list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { personaGemie } from '../../__tests__/support/gemies.js';

const asked = vi.hoisted(() => ({
  oxy: [] as Array<Record<string, unknown>>,
  mcp: 0,
  agent: 0,
}));

vi.mock('../tools/mcp.js', () => ({
  buildMcpTools: vi.fn(async () => {
    asked.mcp += 1;
    return { mcp_row__act: { description: 'connector' } };
  }),
}));
vi.mock('../tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async (_userId: string, context: Record<string, unknown>) => {
    asked.oxy.push(context);
    return { oxy_inbox__listMessages: { description: 'inbox' } };
  }),
}));
vi.mock('../tools/send-message.js', () => ({
  buildSendMessageTool: vi.fn(async () => {
    asked.agent += 1;
    return { sendMessage: { description: 'write to a gemie' } };
  }),
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: { agents: child, chat: child, general: child, v1: child, providers: child, tools: child },
  };
});
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/integrations/connectedAccountRepository.js', () => ({
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

const { ToolPipeline } = await import('../tool-pipeline.js');

type Options = Parameters<typeof ToolPipeline.forUser>[0];

/** Eusebio as production has it: a persona with its own mailbox and these grants. */
const eusebio = personaGemie({
  _id: 'gemie-1',
  id: 'gemie-1',
  name: 'Eusebio',
  ownerOxyAccountId: 'owner-1',
  capabilityGrants: [
    'web',
    'memory',
    'automation',
    'artifacts',
    'computer',
    'delegation',
    'browser',
  ],
});

/** The coordinated session's runtime, which both turns run (the chat route opens it for both). */
function runtime(): NonNullable<Options['runtime']> {
  return {
    session: { _id: 's1', agentId: 'gemie-1', oxyUserId: 'owner-1' },
    onComplete: () => undefined,
    todoManager: { update: () => undefined, toJSON: () => ({ items: [] }), serialize: () => '' },
    browserSession: { execute: async () => '' },
    computer: {},
    scheduleFollowUp: async () => 'Scheduled.',
    continueInBackground: async () => 'Started.',
  } as unknown as NonNullable<Options['runtime']>;
}

/** What the chat route passes for both: everything but who is present and how. */
const COMMON = {
  userId: 'owner-1',
  actsForPerson: true,
  toolsEnabled: true,
  webSearch: true,
  isLocalRuntime: false,
  agent: eusebio,
  sseEmitter: { emit: vi.fn() } as unknown as Options['sseEmitter'],
  conversationId: 'telegram:8988966019:570038640',
  // The person is the one in this chat, in the app and on their gemie's bot alike (ADR 0041).
  gemieChat: 'telegram:8988966019:570038640',
} satisfies Partial<Options>;

/** The structural preconditions only the app meets: a bearer to mint under, a card to draw. */
const APP_ONLY = [
  'askUserQuestion',
  'createAgent',
  'listMyAgents',
  'planPreview',
  'suggestNewConversation',
  'updateAgent',
];

beforeEach(() => {
  vi.stubEnv('INTEGRATIONS_URL', 'https://integrations.example.test');
  asked.oxy = [];
  asked.mcp = 0;
  asked.agent = 0;
});

describe('the person on their gemie’s Telegram bot', () => {
  it('gets the same tools as in the app, with the same reach to their Oxy apps', async () => {
    const app = await ToolPipeline.forUser({
      ...COMMON,
      accessToken: 'bearer',
      isDirectSession: true,
      runtime: runtime(),
    });
    const appOxy = asked.oxy.at(-1);
    const telegram = await ToolPipeline.forUser({
      ...COMMON,
      isDirectSession: false,
      personPresent: true,
      oxyTaskId: 'bot-task',
      runtime: runtime(),
    });
    const telegramOxy = asked.oxy.at(-1);

    const appTools = Object.keys(app.tools).sort();
    const telegramTools = Object.keys(telegram.tools).sort();
    expect(appTools.filter((name) => !telegramTools.includes(name))).toEqual(APP_ONLY);
    expect(telegramTools.filter((name) => !appTools.includes(name))).toEqual([]);

    // What was missing in production, present now: Inbox and the other Oxy apps, the connectors,
    // the granted accounts, memory, scheduling and the computer.
    for (const name of [
      'oxy_inbox__listMessages',
      'mcp_row__act',
      'listAccountChats',
      'memory',
      'searchThread',
      'createAutomation',
      'scheduleFollowUp',
      // Writing to the person's other gemies and agents, external ones included (ADR 0041).
      'sendMessage',
      'run_computer_command',
    ]) {
      expect(telegramTools).toContain(name);
    }

    // The same person, owner and identity; the authority is the task they granted instead of a
    // bearer — the lane scheduled work uses.
    expect(telegramOxy).toMatchObject({
      requesterAccountId: appOxy?.requesterAccountId,
      ownerAccountId: appOxy?.ownerAccountId,
      agentIdentity: appOxy?.agentIdentity,
      taskId: 'bot-task',
      userAccessToken: undefined,
    });
    expect(appOxy).toMatchObject({
      requesterAccountId: 'owner-1',
      agentIdentity: { forUser: 'owner', self: true },
    });
  });

  it('a contact writing to a connected account is not the person: no task creation for them', async () => {
    const contact = await ToolPipeline.forUser({
      ...COMMON,
      isDirectSession: false,
      oxyTaskId: 'account-task',
    });
    expect(Object.keys(contact.tools)).not.toContain('createAutomation');
  });
});
