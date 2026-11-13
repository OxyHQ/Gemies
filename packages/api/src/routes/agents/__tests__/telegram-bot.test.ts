/**
 * `/agents/:id/telegram-bot` — a gemie's own Telegram bot (ADR 0037). Under test: who may manage it
 * (whoever may act as the gemie), that the token reaches only the integrations process and is kept
 * encrypted here, that a bot belongs to one gemie, that only the person who connected it decides
 * whether their credits pay for it, and that removing it stops its webhook.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = `8000000002:${'B'.repeat(35)}`;
const GEMIE = {
  _id: 'gemie-1',
  oxyAccountId: 'gemie-account',
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
    return state.bot;
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
    state.bot = null;
    state.token = null;
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
        profile: { name: true, description: true, photo: true },
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
      '/telegram/bots/profile': { profile: { name: true, description: true, photo: false } },
    };
    if (path === '/telegram/bots/teardown') return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answers[path] ?? {}), { status: 200 });
  }),
}));
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

  it('connects with the gemie’s profile and keeps the token here, never in an answer', async () => {
    expect(await call('GET', '/agents/gemie-1/telegram-bot')).toEqual({
      status: 200,
      body: { bot: null, available: true },
    });

    const connected = await call('PUT', '/agents/gemie-1/telegram-bot', {
      token: TOKEN,
      ownerPaysAgentTurns: true,
      photoJpegBase64: 'AAAA',
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
    expect(state.integrations[0]).toEqual({
      path: '/telegram/bots/setup',
      body: {
        token: TOKEN,
        profile: {
          name: 'Viajes',
          description: GEMIE.description,
          shortDescription: GEMIE.tagline,
          photoJpegBase64: 'AAAA',
        },
      },
    });
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
    const patched = await call('PATCH', '/agents/gemie-1/telegram-bot', {
      groupReplies: 'never',
      syncProfile: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.groupReplies).toBe('never');
    expect(patched.body.profile).toEqual({ name: true, description: true, photo: false });
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
});
