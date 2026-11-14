import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageRow } from '../../../db/chat/messageRepository.js';

/**
 * The ONE shape a client receives a conversation message in (`lib/chat/client-message.ts`), and
 * the proof that every client-facing read of a conversation serves exactly it.
 *
 * Why this exists: `GET /v1/conversations/telegram:8988966019:570038640` served the gemie bot's
 * channel prompt as its first message (`role: "system"`) and the vote, because each read passed
 * the stored row through. The contract below is an allow-list: a field a writer adds to the row
 * reaches no client until this file says so. A tool's result is the tool's (a host app's card
 * draws from it), bounded as the model read it and without an image's bytes.
 */

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  published: [] as Array<{ type: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../../middleware/auth.js')>(
    '../../../middleware/auth.js',
  );
  const asPerson = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'person' };
    next();
  };
  return { ...actual, authenticateToken: asPerson, authenticateTokenOrApiKey: asPerson };
});
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child } };
});
vi.mock('../../../db/index.js', async () => ({
  ...(await vi.importActual<typeof import('../../../db/index.js')>('../../../db/index.js')),
  getDb: () => ({}),
}));
vi.mock('../../../db/realtime/accountEventRepository.js', () => ({
  accountEventHead: async () => 7,
}));
vi.mock('../../../db/chat/conversationRepository.js', async () => ({
  ...(await vi.importActual<typeof import('../../../db/chat/conversationRepository.js')>(
    '../../../db/chat/conversationRepository.js',
  )),
  findConversation: async () => ({ conversationId: 'c', agentId: 'gemie' }),
  unreadPerAgent: async () => new Map(),
}));
vi.mock('../conversation-summary.js', () => ({
  summarizeConversations: async () => [{ id: 'c', title: 'Telegram · Nate' }],
}));
vi.mock('../../../db/chat/messageRepository.js', async () => ({
  ...(await vi.importActual<typeof import('../../../db/chat/messageRepository.js')>(
    '../../../db/chat/messageRepository.js',
  )),
  listMessages: async () => H.rows,
  listMessagesFromSeq: async () => H.rows,
}));
vi.mock('../../realtime/publish.js', () => ({
  publishAccountEvent: async (_user: string, type: string, payload: Record<string, unknown>) => {
    H.published.push({ type, payload });
  },
}));

import conversationsRouter from '../../../routes/conversations.js';
import { publishConversation } from '../../realtime/conversations.js';
import { toClientMessage } from '../client-message.js';

const AT = new Date('2026-11-14T09:19:42.666Z');

function stored(over: Partial<MessageRow>): MessageRow {
  return {
    id: 'row-pk',
    conversationId: 'c',
    oxyUserId: 'person',
    clientMessageId: 'telegram:570038640:53',
    role: 'user',
    content: 'Salúdame en un minuto',
    vote: null,
    reactions: null,
    reactionRevision: 0,
    toolInvocations: null,
    agentInfoId: null,
    agentInfoName: null,
    agentInfoColor: null,
    agentInfoCharacter: null,
    agentInfoHandle: null,
    seq: 32,
    interruptedAfterMs: null,
    createdAt: AT,
    ...over,
  };
}

/** What production stored for that Telegram chat, shaped as its rows were. */
const [SYSTEM_ROW, USER_ROW, REPLY_ROW] = [
  stored({
    id: 'r0',
    clientMessageId: 'msg-0',
    role: 'system',
    content: 'The user is chatting via telegram. Be concise and friendly.',
    seq: 0,
  }),
  stored({ id: 'r1', seq: 1 }),
  stored({
    id: 'r2',
    clientMessageId: 'reply:telegram:570038640:53',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Tienes **20 emails** sin leer.' },
      { type: 'reasoning', text: 'the model’s scratch' },
    ],
    vote: 'up',
    reactions: ['❤️'],
    reactionRevision: 2,
    interruptedAfterMs: 1200,
    toolInvocations: [
      {
        toolCallId: 'call-1',
        toolName: 'oxy_inbox__getUnreadEmails',
        state: 'result',
        args: { limit: 20 },
        result: {
          data: [
            {
              _id: 'e1',
              id: 'e1',
              subject: 'Acción necesaria',
              cc: [],
              inReplyTo: null,
              aliasTag: null,
              labels: [],
            },
          ],
        },
      },
    ],
    agentInfoId: 'gemie',
    agentInfoName: 'Eusebio',
    agentInfoHandle: 'eusebio',
    seq: 33,
  }),
];
const ROWS: MessageRow[] = [SYSTEM_ROW, USER_ROW, REPLY_ROW];

describe('a client message', () => {
  it('is exactly the allow-listed fields', () => {
    const message = toClientMessage(REPLY_ROW);
    expect(Object.keys(message ?? {}).sort()).toEqual(
      [
        'agentInfo',
        'content',
        'createdAt',
        'id',
        'reactionRevision',
        'reactions',
        'role',
        'seq',
        'toolInvocations',
      ].sort(),
    );
    expect(message).toEqual({
      id: 'reply:telegram:570038640:53',
      role: 'assistant',
      // The words the thread draws; never the model's scratch.
      content: [{ type: 'text', text: 'Tienes **20 emails** sin leer.' }],
      toolInvocations: [
        {
          toolCallId: 'call-1',
          toolName: 'oxy_inbox__getUnreadEmails',
          state: 'result',
          args: { limit: 20 },
          // The result as the tool returned it and the model read it (bounded when it did not
          // fit): a host app's card draws from it, an empty list included.
          result: {
            data: [
              {
                _id: 'e1',
                id: 'e1',
                subject: 'Acción necesaria',
                cc: [],
                inReplyTo: null,
                aliasTag: null,
                labels: [],
              },
            ],
          },
        },
      ],
      reactions: ['❤️'],
      reactionRevision: 2,
      agentInfo: { id: 'gemie', name: 'Eusebio', color: null, character: null, handle: 'eusebio' },
      seq: 33,
      createdAt: AT,
    });
  });

  it('is never a system or tool row', () => {
    expect(toClientMessage(SYSTEM_ROW)).toBeNull();
    expect(toClientMessage(stored({ role: 'tool' }))).toBeNull();
  });
});

describe('no client-facing conversation payload carries a system message', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/conversations', conversationsRouter);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    H.rows = ROWS;
  });

  afterAll(
    async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const expectClientShape = (payload: unknown, messages: unknown[]) => {
    const text = JSON.stringify(payload);
    expect(text).not.toContain('"role":"system"');
    expect(text).not.toContain('The user is chatting via');
    expect(text).not.toContain('"vote"');
    expect(text).not.toContain('interruptedAfterMs');
    expect(messages).toEqual(
      ROWS.flatMap((row) => {
        const message = toClientMessage(row);
        return message === null ? [] : [JSON.parse(JSON.stringify(message))];
      }),
    );
  };

  it('GET /conversations/:id', async () => {
    const response = await fetch(`${base}/conversations/c`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expectClientShape(body, body.messages);
  });

  it('the realtime `conversation` frame', async () => {
    H.published = [];
    await publishConversation('person', 'c', { appendedFromSeq: 0 });
    const frame = H.published.find((event) => event.type === 'conversation');
    expect(frame).toBeDefined();
    const appended = JSON.parse(JSON.stringify(frame?.payload.appended)) as unknown[];
    expectClientShape(frame?.payload, appended);
  });
});
