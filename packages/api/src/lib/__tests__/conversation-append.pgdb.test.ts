import { randomUUID } from 'node:crypto';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../chat-core.js', () => ({ resolveUtilityModel: vi.fn(), getAIModel: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));

const { closePostgres, connectPostgres, getDb } = await import('../../db/index.js');
const { insertMessages, listMessages, toStoredMessage } = await import(
  '../../db/chat/messageRepository.js'
);
const { findConversation } = await import('../../db/chat/conversationRepository.js');
const { appendConversationMessages, saveConversation } = await import('../conversation-saver.js');

/**
 * An exchange only the server saw is appended at the end of the conversation,
 * by `seq`, without a client history, and what an answer of a call from before
 * ADR 0041 recorded about its interruption survives a later full rewrite by a
 * typed turn.
 */

beforeAll(() => {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('Test DB required');
});
afterAll(closePostgres);

describe('appendConversationMessages', () => {
  it('creates the conversation and appends in order, concurrently', async () => {
    const userId = `voice-append-${randomUUID()}`;
    const conversationId = randomUUID();
    await appendConversationMessages({
      agentId: ALIA_GEMIE_ID,
      userId,
      conversationId,
      titleOnInsert: 'Hola',
      messages: [
        { id: 'v-u1', role: 'user', content: 'Hola' },
        { id: 'v-a1', role: 'assistant', content: 'Hola, ¿qué tal?' },
      ],
    });
    // Two exchanges completing at once claim the same seq: one retries.
    await Promise.all([
      appendConversationMessages({
        agentId: ALIA_GEMIE_ID,
        userId,
        conversationId,
        titleOnInsert: 'x',
        messages: [{ id: 'v-u2', role: 'user', content: 'uno' }],
      }),
      appendConversationMessages({
        agentId: ALIA_GEMIE_ID,
        userId,
        conversationId,
        titleOnInsert: 'x',
        messages: [{ id: 'v-u3', role: 'user', content: 'dos' }],
      }),
    ]);
    const rows = await listMessages(getDb(), userId, conversationId);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3]);
    expect(rows.slice(0, 2).map((row) => [row.clientMessageId, row.role])).toEqual([
      ['v-u1', 'user'],
      ['v-a1', 'assistant'],
    ]);
    expect(toStoredMessage(rows[1]!).interruptedAfterMs).toBeUndefined();
    const conversation = await findConversation(getDb(), userId, conversationId);
    expect(conversation?.title).toBe('Hola');
  });

  it('the interruption survives a typed turn that rewrites the thread', async () => {
    const userId = `voice-append-${randomUUID()}`;
    const conversationId = randomUUID();
    await appendConversationMessages({
      agentId: ALIA_GEMIE_ID,
      userId,
      conversationId,
      titleOnInsert: 'Hola',
      messages: [{ id: 'v-u1', role: 'user', content: 'Hola' }],
    });
    // An answer stored by a call from before ADR 0041, with what of it was heard.
    await insertMessages(getDb(), [
      {
        conversationId,
        oxyUserId: userId,
        clientMessageId: 'v-a1',
        role: 'assistant',
        content: 'Respuesta larga',
        seq: 1,
        interruptedAfterMs: 1200,
      },
    ]);
    // A client whose copy diverges (an edited first message) forces the full rewrite.
    await saveConversation({
      agentId: ALIA_GEMIE_ID,
      userId,
      conversationId,
      messages: [
        { id: 'v-u1', role: 'user', content: 'Hola (editado)' },
        { id: 'v-a1', role: 'assistant', content: 'Respuesta larga' },
        { id: 'typed-1', role: 'user', content: 'Y ahora escribo' },
      ],
      assistantResponse: 'Vale.',
      assistantMessageId: 'typed-2',
    });
    const rows = await listMessages(getDb(), userId, conversationId);
    const answer = rows.find((row) => row.clientMessageId === 'v-a1');
    expect(answer?.interruptedAfterMs).toBe(1200);
    expect(rows).toHaveLength(4);
  });
});
