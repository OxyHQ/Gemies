/**
 * Alia's thread with a person (ADR 0034, ADR 0009): one per person, apart from her loose chats, by
 * the same routes and reads as any gemie's — driven through the REAL routers against a REAL
 * Postgres, because every property here is the database's (which rows a thread read covers, that
 * two opens at once find one thread, that a saved turn does not move a stretch out of its thread).
 *
 * Alia is the row migration 0135 seeds (`ALIA_GEMIE_ID`): public, active, `task_authority =
 * 'standing'`. A persona created here is an ordinary `session` gemie, whose thread is the pair, and
 * the last block holds that it did not change.
 *
 * Only Oxy is replaced: where an agent opens (ADR 0021) and the identity lookup, which fails open.
 * Every account and conversation id is unique to this file: the pgdb suite shares one database.
 */

import { TEST_CHARACTER } from '../../../db/__tests__/support/agent-character';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { and, eq } from 'drizzle-orm';

vi.mock('../../../lib/agent-availability.js', () => ({ agentOpensOn: async () => 'reachable' }));
// The identity lookup fails open (no names): nothing here may reach a real Oxy.
vi.mock('../../../lib/oxy-user-hydration.js', () => ({ hydrateOxyUsers: async () => new Map() }));
vi.mock('../../../lib/s3.js', () => ({
  uploadToS3: vi.fn(),
  deleteS3Objects: vi.fn(async () => 0),
}));
vi.mock('../../../middleware/auth.js', () => {
  /** The caller is whoever the request names; the routes' own rules decide the rest. */
  const signIn = (req: Request, _res: Response, next: NextFunction): void => {
    const typed = req as Request & { user?: { id: string }; accessToken?: string };
    typed.user = { id: String(req.header('x-test-user')) };
    typed.accessToken = 'token';
    next();
  };
  return { authenticateToken: signIn, optionalAuth: signIn, authenticateTokenOrApiKey: signIn };
});
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      agents: child,
      chat: child,
      general: child,
      v1: child,
      credits: child,
      providers: child,
    },
  };
});

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { ALIA_GEMIE_ID } from '../../../domain/alia-gemie.js';
import { createAgent } from '../../../db/agents/agentRepository.js';
import { agentThreads } from '../../../db/schema/agent-runtime.js';
import { conversations } from '../../../db/schema/chat.js';
import { upsertConversation } from '../../../db/chat/conversationRepository.js';
import { insertMessages } from '../../../db/chat/messageRepository.js';
import { resolveTurnGemie } from '../../../lib/chat/turn-inputs.js';
import { threadIsThePair } from '../../../lib/gemie-thread.js';
import threadRouter, { gemieThreadByIdRouter } from '../thread.js';
import conversationsRouter from '../../conversations.js';

let db: ApiDatabase;
let server: Server;
let baseUrl: string;

const SUITE = `alia-thread-${process.pid}`;
let seq = 0;
const person = () => `${SUITE}-person-${seq++}`;

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;

  const app = express();
  app.use(express.json());
  app.use('/agents', threadRouter);
  app.use('/agents', gemieThreadByIdRouter);
  app.use('/conversations', conversationsRouter);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: String(err) });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

type Body = Record<string, unknown>;

async function call(
  userId: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Body,
): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const openAlia = (userId: string) => call(userId, 'GET', `/agents/${ALIA_GEMIE_ID}/thread`);

async function say(userId: string, conversationId: string, text: string, at: string) {
  await insertMessages(db, [
    {
      conversationId,
      oxyUserId: userId,
      role: 'user',
      content: text,
      seq: 0,
      createdAt: new Date(at),
    },
  ]);
}

async function conversationRow(userId: string, conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.oxyUserId, userId), eq(conversations.conversationId, conversationId)),
    );
  return row;
}

async function aliaThreadRows(userId: string) {
  return db
    .select()
    .from(agentThreads)
    .where(and(eq(agentThreads.oxyUserId, userId), eq(agentThreads.agentId, ALIA_GEMIE_ID)));
}

describe('Alia has one thread per person', () => {
  it('opens it by her gemie id, as a row of its own, and the same one every time', async () => {
    const ana = person();

    const first = await openAlia(ana);
    expect(first.status).toBe(200);
    expect(typeof first.body.threadId).toBe('string');
    expect(typeof first.body.conversationId).toBe('string');
    expect((first.body.agent as Body)._id).toBe(ALIA_GEMIE_ID);

    // Her stretch belongs to her gemie AND to the thread row; a loose chat carries no row.
    const stretch = await conversationRow(ana, String(first.body.conversationId));
    expect(stretch?.agentId).toBe(ALIA_GEMIE_ID);
    expect(stretch?.agentThreadId).toBe(first.body.threadId);
    expect(stretch?.title).toBe('Alia');

    const again = await openAlia(ana);
    expect(again.body).toEqual(first.body);
    expect(await aliaThreadRows(ana)).toHaveLength(1);
  });

  it('finds ONE thread when a person opens it from several devices at once', async () => {
    const ana = person();
    const opened = await Promise.all(Array.from({ length: 6 }, () => openAlia(ana)));

    expect(new Set(opened.map((o) => o.body.threadId)).size).toBe(1);
    expect(new Set(opened.map((o) => o.body.conversationId)).size).toBe(1);
    expect(await aliaThreadRows(ana)).toHaveLength(1);
  });

  it('gives two people two threads with the same Alia', async () => {
    const ana = person();
    const bea = person();
    const [a, b] = [await openAlia(ana), await openAlia(bea)];
    expect(a.body.threadId).not.toBe(b.body.threadId);
    expect(a.body.conversationId).not.toBe(b.body.conversationId);
  });
});

describe('her loose chats stay apart', () => {
  it('reads and searches only the thread, never a loose chat', async () => {
    const ana = person();
    const loose = await call(ana, 'POST', '/conversations/new', {});
    expect(loose.body.agentId).toBeNull();
    expect(loose.body.threadId).toBeNull();
    const opened = await openAlia(ana);

    await say(ana, String(loose.body.id), 'loose banana', '2026-11-12T10:00:00Z');
    await say(ana, String(opened.body.conversationId), 'thread banana', '2026-11-12T10:01:00Z');

    const page = await call(ana, 'GET', `/agents/${ALIA_GEMIE_ID}/thread/messages`);
    expect(page.status).toBe(200);
    expect((page.body.messages as Body[]).map((m) => m.content)).toEqual(['thread banana']);

    const found = await call(ana, 'GET', `/agents/${ALIA_GEMIE_ID}/thread/search?q=banana`);
    expect((found.body.hits as Body[]).map((h) => h.snippet)).toEqual(['thread banana']);

    // The list files each where it belongs: the stretch under the thread, the chat loose.
    const list = await call(ana, 'GET', '/conversations');
    const byId = new Map((list.body.conversations as Body[]).map((c) => [c.id, c]));
    expect(byId.get(loose.body.id)?.threadId).toBeNull();
    expect(byId.get(opened.body.conversationId)?.threadId).toBe(opened.body.threadId);
    // Both are Alia's on the wire, as a chat with her always was.
    expect(byId.get(opened.body.conversationId)?.agentId).toBeNull();
  });

  it('has nothing in a thread never opened, however many loose chats there are', async () => {
    // The read that would leak: with no thread row, the pair is every loose chat.
    const ana = person();
    const loose = await call(ana, 'POST', '/conversations/new', {});
    await say(ana, String(loose.body.id), 'only loose', '2026-11-12T11:00:00Z');

    const page = await call(ana, 'GET', `/agents/${ALIA_GEMIE_ID}/thread/messages`);
    expect(page.body).toEqual({ messages: [], nextCursor: null });
    const found = await call(ana, 'GET', `/agents/${ALIA_GEMIE_ID}/thread/search?q=loose`);
    expect(found.body).toEqual({ hits: [] });
    expect(await aliaThreadRows(ana)).toHaveLength(0);
  });
});

describe('the thread’s next stretch', () => {
  it('starts with POST /conversations/new { threadId }, becomes the active one, and reads as one', async () => {
    const ana = person();
    const opened = await openAlia(ana);
    await say(ana, String(opened.body.conversationId), 'first stretch', '2026-11-12T12:00:00Z');

    const next = await call(ana, 'POST', '/conversations/new', { threadId: opened.body.threadId });
    expect(next.status).toBe(200);
    expect(next.body.threadId).toBe(opened.body.threadId);
    expect(next.body.agentId).toBeNull();
    await say(ana, String(next.body.id), 'second stretch', '2026-11-12T12:05:00Z');

    const reopened = await openAlia(ana);
    expect(reopened.body.conversationId).toBe(next.body.id);
    expect(reopened.body.threadId).toBe(opened.body.threadId);

    const page = await call(ana, 'GET', `/agents/${ALIA_GEMIE_ID}/thread/messages`);
    const messages = page.body.messages as Body[];
    expect(messages.map((m) => m.content)).toEqual(['first stretch', 'second stretch']);
    expect(messages.map((m) => m.conversationId)).toEqual([
      opened.body.conversationId,
      next.body.id,
    ]);
  });

  it('refuses another person’s thread, and a thread named with another gemie, as not found', async () => {
    const ana = person();
    const bea = person();
    const opened = await openAlia(ana);

    const stranger = await call(bea, 'POST', '/conversations/new', {
      threadId: opened.body.threadId,
    });
    expect(stranger.status).toBe(404);

    const persona = await seedPersona();
    const mismatched = await call(ana, 'POST', '/conversations/new', {
      threadId: opened.body.threadId,
      agentId: persona,
    });
    expect(mismatched.status).toBe(404);

    const group = await call(ana, 'POST', '/conversations/new', {
      threadId: opened.body.threadId,
      agentIds: [persona, persona],
    });
    expect(group.status).toBe(400);
  });

  it('a turn saved into a stretch keeps it in the thread', async () => {
    // What `lib/conversation-saver.ts` writes after every turn: the upsert never touches the row.
    const ana = person();
    const opened = await openAlia(ana);
    await upsertConversation(db, {
      oxyUserId: ana,
      conversationId: String(opened.body.conversationId),
      lastMessage: 'hola',
      titleOnInsert: 'New chat',
      source: 'app',
      agentId: ALIA_GEMIE_ID,
    });
    const stretch = await conversationRow(ana, String(opened.body.conversationId));
    expect(stretch?.agentThreadId).toBe(opened.body.threadId);
    expect(stretch?.lastMessage).toBe('hola');
  });
});

describe('a turn in her thread is a turn of Alia', () => {
  it('runs as her gemie, whether the client names her id or no gemie at all', async () => {
    const ana = person();
    const identity = {
      oxyUserId: ana,
      accessToken: 'token',
      isDirectUserSession: true,
      surfaceApplicationId: null,
      loadUserMemory: true,
    };
    for (const requestedAgentId of [undefined, ALIA_GEMIE_ID]) {
      const turn = await resolveTurnGemie({ ...identity, requestedAgentId });
      expect(turn.kind).toBe('agent');
      if (turn.kind !== 'agent') continue;
      // Nilo memory, the person's reach, no mailbox, standing authority: no agent session.
      expect(turn.agent._id).toBe(ALIA_GEMIE_ID);
      expect(turn.agent.memoryStore).toBe('nilo');
      expect(turn.agent.reach).toBe('person');
      expect(turn.agent.mailbox).toBe(false);
      expect(turn.agent.taskAuthority).toBe('standing');
      expect(threadIsThePair(turn.agent)).toBe(false);
    }
  });
});

/** An ordinary, public persona: a `session` gemie, whose thread is every conversation of the pair. */
async function seedPersona(): Promise<string> {
  const agent = await createAgent(db, {
    character: TEST_CHARACTER,
    oxyAccountId: `oxy-bot-${SUITE}-${seq++}`,
    ownerOxyAccountId: SUITE,
    tagline: 'finds things out',
    description: 'd',
    authorOxyUserId: SUITE,
    category: 'research',
    isPublished: true,
    access: 'public',
  });
  return agent._id;
}

describe('another gemie’s thread does not change', () => {
  it('is still every conversation of the pair, with no thread row, by handle or by id', async () => {
    const ana = person();
    const persona = await seedPersona();
    // Alia's thread opened beside it changes nothing of the persona's.
    await openAlia(ana);

    const opened = await call(ana, 'GET', `/agents/${persona}/thread`);
    expect(opened.status).toBe(200);
    expect(opened.body.threadId).toBeNull();
    const first = String(opened.body.conversationId);
    expect((await conversationRow(ana, first))?.agentThreadId).toBeNull();

    // A new stretch is still POST /conversations/new with its agentId, and becomes the active one.
    const second = await call(ana, 'POST', '/conversations/new', { agentId: persona });
    expect(second.body.threadId).toBeNull();
    await say(ana, first, 'persona one', '2026-11-12T13:00:00Z');
    await say(ana, String(second.body.id), 'persona two', '2026-11-12T13:01:00Z');

    const reopened = await call(ana, 'GET', `/agents/${persona}/thread`);
    expect(reopened.body.conversationId).toBe(second.body.id);

    const page = await call(ana, 'GET', `/agents/${persona}/thread/messages`);
    expect((page.body.messages as Body[]).map((m) => m.content)).toEqual([
      'persona one',
      'persona two',
    ]);
    const found = await call(ana, 'GET', `/agents/${persona}/thread/search?q=persona`);
    expect(found.body.hits as Body[]).toHaveLength(2);

    const rows = await db.select().from(agentThreads).where(eq(agentThreads.agentId, persona));
    expect(rows).toHaveLength(0);
    expect(threadIsThePair({ taskAuthority: 'session' })).toBe(true);
  });

  it('answers 404 for an id that is no gemie, with the body a handle gets', async () => {
    const res = await call(person(), 'GET', '/agents/00000000-0000-7000-8000-000000000000/thread');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Agent not found' });
  });
});
