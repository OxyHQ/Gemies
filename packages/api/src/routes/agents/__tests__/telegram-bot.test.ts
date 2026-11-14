/**
 * `/agents/:id/telegram-bot` — a gemie's own Telegram bot (ADR 0037). Under test: who may manage it
 * (whoever may act as the gemie), that the token reaches only the integrations process and is kept
 * encrypted here, that a bot belongs to one gemie, that only the person who connected it decides
 * whether their credits pay for it, that removing it stops its webhook, and (amendment) that only
 * that person links their Telegram to it, granting the gemie their authority there, and that the
 * authority goes when the link or the bot does.
 */
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = `8000000002:${'B'.repeat(35)}`;
const GEMIE = {
  _id: 'gemie-1',
  oxyAccountId: 'gemie-account',
  reach: 'grants',
  identity: { source: 'oxy', oxyAccountId: 'gemie-account' },
  tagline: 'Plans your trips',
  description: 'A travel gemie that plans trips end to end.',
};

const state = vi.hoisted(() => ({
  loaded: { ok: true } as { ok: boolean; agent?: unknown; refusal?: string },
  bot: null as Record<string, unknown> | null,
  token: null as string | null,
  takenByAnother: false,
  saved: [] as unknown[],
  integrations: [] as Array<{ path: string; body: Record<string, unknown> }>,
  integrationsFail: null as null | { status: number; body: unknown },
  minted: [] as Array<Record<string, unknown>>,
  revoked: [] as string[],
  linkCodes: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../lib/oxy-task-authority.js', () => ({
  createOxyTask: vi.fn(async (input: Record<string, unknown>) => {
    state.minted.push(input);
    return `task-${state.minted.length}`;
  }),
  revokeReleasedTask: vi.fn(async (taskId: string | null) => {
    if (taskId) state.revoked.push(taskId);
  }),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'person-1' }, accessToken: 'PERSON-TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/agent-account.js', () => ({
  loadAgentForActor: vi.fn(async () => state.loaded),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../../lib/agent-identity.js', () => ({
  attachAgentIdentity: vi.fn(async (agent: object) => ({
    ...agent,
    name: 'Viajes',
    handle: 'viajes',
  })),
  agentPromptName: vi.fn((agent: { name: string }) => agent.name),
}));
vi.mock('../../../db/integrations/gemieBotRepository.js', () => ({
  findGemieBot: vi.fn(async () => state.bot),
  findGemieBotToken: vi.fn(async () => state.token),
  telegramBotTakenByAnother: vi.fn(async () => state.takenByAnother),
  saveGemieBot: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    state.saved.push(input);
    state.bot = {
      ...input,
      status: 'active',
      groupReplies: 'mentions',
      totalMessages: 0,
      lastMessageAt: null,
    };
    state.token = String(input.botToken);
    return { bot: state.bot, released: null };
  }),
  setGemieBotLinkCode: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    state.linkCodes.push(input);
    const replaced = (state.bot?.oxyTaskId as string | null) ?? null;
    state.bot = { ...state.bot, oxyTaskId: input.oxyTaskId };
    return { bot: state.bot, replaced };
  }),
  unlinkGemieBotPerson: vi.fn(async () => {
    const released = (state.bot?.oxyTaskId as string | null) ?? null;
    state.bot = {
      ...state.bot,
      oxyTaskId: null,
      linkedTelegramUserId: null,
      linkedTelegramName: null,
    };
    return { bot: state.bot, released };
  }),
  setGemieBotSettings: vi.fn(async (_db: unknown, _id: string, patch: object) => {
    state.bot = { ...state.bot, ...patch };
    return state.bot;
  }),
  setGemieBotOwnerPays: vi.fn(async (_db: unknown, _id: string, _user: string, pays: boolean) => {
    state.bot = { ...state.bot, ownerPaysAgentTurns: pays };
    return state.bot;
  }),
  deleteGemieBot: vi.fn(async () => {
    const released = (state.bot?.oxyTaskId as string | null) ?? null;
    state.bot = null;
    state.token = null;
    return released;
  }),
}));
vi.mock('../../../lib/integrations-client.js', () => ({
  integrationsServiceFetch: vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    state.integrations.push({ path, body });
    if (state.integrationsFail) {
      return new Response(JSON.stringify(state.integrationsFail.body), {
        status: state.integrationsFail.status,
      });
    }
    const answers: Record<string, unknown> = {
      '/telegram/bots/setup': {
        botId: '8000000002',
        username: 'viajes_bot',
        name: 'Viajes',
        canJoinGroups: true,
        canReadAllGroupMessages: false,
      },
      '/telegram/bots/status': {
        username: 'viajes_bot',
        name: 'Viajes',
        canJoinGroups: true,
        canReadAllGroupMessages: false,
        webhook: 'ok',
        webhookError: null,
        pendingUpdates: 0,
      },
    };
    if (path === '/telegram/bots/teardown') return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answers[path] ?? {}), { status: 200 });
  }),
}));
const sync = vi.hoisted(() => ({ now: vi.fn(async (_agentId: string) => {}) }));
const realtime = vi.hoisted(() => ({ gemies: [] as unknown[][] }));
vi.mock('../../../lib/realtime/account.js', () => ({
  publishGemieChanged: vi.fn(async (...args: unknown[]) => {
    realtime.gemies.push(args);
  }),
}));
vi.mock('../../../lib/gemie-telegram-bot-profile.js', () => ({ syncGemieBotProfileNow: sync.now }));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { channels: child, agents: child, general: child } };
});

const { default: router } = await import('../telegram-bot.js');

const app = express();
app.use(express.json());
app.use('/agents', router);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeEach(() => {
  vi.stubEnv('INTEGRATIONS_URL', 'https://integrations.example.test');
  state.loaded = { ok: true, agent: GEMIE };
  state.bot = null;
  state.token = null;
  state.takenByAnother = false;
  state.saved = [];
  state.integrations = [];
  state.integrationsFail = null;
  state.minted = [];
  state.revoked = [];
  state.linkCodes = [];
});

describe('a gemie’s own Telegram bot', () => {
  it('is managed only by whoever may act as the gemie', async () => {
    state.loaded = { ok: false, refusal: 'agent_not_found' };
    expect((await call('GET', '/agents/gemie-1/telegram-bot')).status).toBe(404);
    expect(
      (
        await call('PUT', '/agents/gemie-1/telegram-bot', {
          token: TOKEN,
          ownerPaysAgentTurns: true,
        })
      ).status,
    ).toBe(404);
    expect(state.integrations).toEqual([]);
  });

  it('connects, has its profile follow at once, and keeps the token here, never in an answer', async () => {
    expect(await call('GET', '/agents/gemie-1/telegram-bot')).toEqual({
      status: 200,
      body: { bot: null, available: true },
    });

    const connected = await call('PUT', '/agents/gemie-1/telegram-bot', {
      token: TOKEN,
      ownerPaysAgentTurns: true,
    });
    expect(connected.status).toBe(201);
    expect(connected.body.bot).toMatchObject({
      username: 'viajes_bot',
      groupReplies: 'mentions',
      ownerPaysAgentTurns: true,
      callerPays: true,
      live: { webhook: 'ok' },
    });
    expect(JSON.stringify(connected.body)).not.toContain(TOKEN);
    expect(state.integrations[0]).toEqual({ path: '/telegram/bots/setup', body: { token: TOKEN } });
    // The bot takes the gemie's profile from the server, at once.
    expect(sync.now).toHaveBeenCalledWith('gemie-1');
    expect(state.saved).toEqual([
      expect.objectContaining({
        agentId: 'gemie-1',
        userId: 'person-1',
        botToken: TOKEN,
        botId: '8000000002',
      }),
    ]);
  });

  it('refuses a token Telegram rejects, and a bot that is another gemie’s', async () => {
    state.integrationsFail = {
      status: 400,
      body: { error: 'Telegram does not accept this token', code: 'invalid_token' },
    };
    expect(
      await call('PUT', '/agents/gemie-1/telegram-bot', {
        token: TOKEN,
        ownerPaysAgentTurns: false,
      }),
    ).toEqual({
      status: 400,
      body: { error: 'Telegram does not accept this token', code: 'invalid_token' },
    });
    state.integrationsFail = null;
    state.takenByAnother = true;
    expect(
      (
        await call('PUT', '/agents/gemie-1/telegram-bot', {
          token: TOKEN,
          ownerPaysAgentTurns: false,
        })
      ).body.code,
    ).toBe('bot_taken');
    expect(state.saved).toEqual([]);
  });

  it('lets only the payer change who pays, and anyone acting as the gemie the rest', async () => {
    await call('PUT', '/agents/gemie-1/telegram-bot', { token: TOKEN, ownerPaysAgentTurns: true });
    state.bot = { ...state.bot, userId: 'someone-else' };
    expect(
      (await call('PATCH', '/agents/gemie-1/telegram-bot', { ownerPaysAgentTurns: false })).status,
    ).toBe(403);
    const patched = await call('PATCH', '/agents/gemie-1/telegram-bot', { groupReplies: 'never' });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.groupReplies).toBe('never');
    // The one manual control left: a retry after the editor showed a failure.
    sync.now.mockClear();
    const retried = await call('PATCH', '/agents/gemie-1/telegram-bot', { retryProfileSync: true });
    expect(retried.status).toBe(200);
    expect(sync.now).toHaveBeenCalledWith('gemie-1');
    // There is no manual "sync profile" any more.
    expect(
      (await call('PATCH', '/agents/gemie-1/telegram-bot', { syncProfile: true })).status,
    ).toBe(400);
  });

  it('stops the bot’s webhook when it is removed', async () => {
    await call('PUT', '/agents/gemie-1/telegram-bot', { token: TOKEN, ownerPaysAgentTurns: true });
    expect((await call('DELETE', '/agents/gemie-1/telegram-bot')).status).toBe(200);
    expect(state.integrations.at(-1)).toEqual({
      path: '/telegram/bots/teardown',
      body: { token: TOKEN },
    });
    expect(state.bot).toBeNull();
  });

  it('links only its person’s Telegram, granting the gemie their authority there', async () => {
    await call('PUT', '/agents/gemie-1/telegram-bot', { token: TOKEN, ownerPaysAgentTurns: true });
    const linked = await call('POST', '/agents/gemie-1/telegram-bot/link');
    expect(linked.status).toBe(200);
    const code = new URL(linked.body.url).searchParams.get('start') ?? '';
    expect(linked.body.url).toBe(`https://t.me/viajes_bot?start=${code}`);
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The person's authority, acted on by the gemie: minted now, with their session.
    expect(state.minted).toEqual([
      {
        accessToken: 'PERSON-TOKEN',
        effectiveAccountId: 'person-1',
        actor: { type: 'agent', accountId: 'gemie-account' },
        origin: { kind: 'automation', id: expect.stringMatching(/^channel:/) },
      },
    ]);
    // Only the code's hash is kept.
    expect(state.linkCodes).toEqual([
      expect.objectContaining({
        agentId: 'gemie-1',
        userId: 'person-1',
        codeHash: createHash('sha256').update(code).digest('hex'),
        oxyTaskId: 'task-1',
      }),
    ]);
    expect(JSON.stringify(state.linkCodes)).not.toContain(code);

    // A new link replaces the task the bot held.
    await call('POST', '/agents/gemie-1/telegram-bot/link');
    expect(state.revoked).toEqual(['task-1']);
  });

  it('refuses to link anyone else’s Telegram to the bot', async () => {
    await call('PUT', '/agents/gemie-1/telegram-bot', { token: TOKEN, ownerPaysAgentTurns: true });
    state.bot = { ...state.bot, userId: 'someone-else' };
    const refused = await call('POST', '/agents/gemie-1/telegram-bot/link');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('not_bot_person');
    expect(state.minted).toEqual([]);
  });

  it('says who is linked, and tells every open editor when that changes', async () => {
    await call('PUT', '/agents/gemie-1/telegram-bot', { token: TOKEN, ownerPaysAgentTurns: true });
    await call('POST', '/agents/gemie-1/telegram-bot/link');
    // The person opened the link in Telegram: the bot recognises them now.
    state.bot = { ...state.bot, linkedTelegramUserId: '570038640', linkedTelegramName: '@nate' };
    const linked = await call('GET', '/agents/gemie-1/telegram-bot');
    expect(linked.body.bot).toMatchObject({ personLinked: true, linkedAs: '@nate' });

    realtime.gemies.length = 0;
    const unlinked = await call('DELETE', '/agents/gemie-1/telegram-bot/link');
    expect(unlinked.body.bot).toMatchObject({ personLinked: false, linkedAs: null });
    expect(realtime.gemies).toEqual([['person-1', 'gemie-1', 'updated']]);
  });

  it('revokes the authority when its person unlinks, or the bot goes', async () => {
    await call('PUT', '/agents/gemie-1/telegram-bot', { token: TOKEN, ownerPaysAgentTurns: true });
    await call('POST', '/agents/gemie-1/telegram-bot/link');
    const unlinked = await call('DELETE', '/agents/gemie-1/telegram-bot/link');
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.bot.personLinked).toBe(false);
    expect(state.revoked).toEqual(['task-1']);

    await call('POST', '/agents/gemie-1/telegram-bot/link');
    await call('DELETE', '/agents/gemie-1/telegram-bot');
    expect(state.revoked).toEqual(['task-1', 'task-2']);
  });
});
