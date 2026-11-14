import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { conversations, gemieConversations, messages } from '../schema/chat';
import {
  createConversation,
  deleteConversation,
  listConversations,
} from '../chat/conversationRepository';
import { isGemieConversation, openGemieConversation } from '../chat/gemieConversationRepository';
import { listGroupMembers } from '../chat/conversationMemberRepository';
import { insertMessages, listMessages, toStoredMessage } from '../chat/messageRepository';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie';
import type { AgentInfo } from '../../domain/conversation';
import type { RoomEvent } from '../../lib/chat/room/bus';
import type { RoomEngineDeps } from '../../lib/chat/room/engine';
import { roomRuntime } from '../../lib/chat/room/runtime';
import { type GemieStepData, processGemieStep } from '../../lib/chat/gemies/engine';
import { DEFAULT_GEMIE_CHAIN_BOUNDS, gemieMessageIdOf } from '../../lib/chat/gemies/policy';

/**
 * Conversations between gemies (ADR 0041) on a real Postgres: one per person and pair, apart from
 * the person's own conversations, and a chain of several turns whose stored conversation is complete
 * and reads back exactly as the conversation view draws it. Then migration 0171, replayed over
 * consultations stored the old way.
 */

const USER = 'gemie-conversations-person';
const PEPE: AgentInfo = {
  id: 'pepe-0170',
  name: 'Pepe',
  handle: 'pepe',
  color: 'teal',
  character: null,
};
const LUMEN: AgentInfo = {
  id: 'lumen-0170',
  name: 'Lumen',
  handle: 'lumen',
  color: null,
  character: null,
};

let db: ApiDatabase;

async function clean() {
  for (const table of [messages, conversations, gemieConversations]) {
    await db.delete(table).where(eq(table.oxyUserId, USER));
  }
  await db.execute(sql`delete from conversation_members where oxy_user_id = ${USER}`);
}

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});
beforeEach(clean);
afterAll(async () => {
  await clean();
  await closePostgres();
});

describe('one conversation per person and pair', () => {
  it('reopens the same conversation whoever writes first, and opens one under a race', async () => {
    const opened = await Promise.all([
      openGemieConversation(db, {
        oxyUserId: USER,
        fromAgentId: 'a',
        toAgentId: 'b',
        title: 'A · B',
      }),
      openGemieConversation(db, {
        oxyUserId: USER,
        fromAgentId: 'b',
        toAgentId: 'a',
        title: 'B · A',
      }),
      openGemieConversation(db, {
        oxyUserId: USER,
        fromAgentId: 'a',
        toAgentId: 'b',
        title: 'A · B',
      }),
    ]);
    expect(new Set(opened.map((o) => o.conversationId)).size).toBe(1);
    expect(opened.filter((o) => o.created)).toHaveLength(1);
    const { conversationId } = opened[0];
    expect(await listGroupMembers(db, USER, conversationId)).toHaveLength(2);
    expect(await isGemieConversation(db, USER, conversationId)).toBe(true);
    // Another person's pair is another conversation.
    const other = await openGemieConversation(db, {
      oxyUserId: `${USER}-2`,
      fromAgentId: 'a',
      toAgentId: 'b',
      title: 'A · B',
    });
    expect(other.conversationId).not.toBe(conversationId);
    await deleteConversation(db, `${USER}-2`, other.conversationId);
  });

  it('is listed only when asked for, never among the person’s own, and goes with its conversation', async () => {
    await createConversation(db, {
      oxyUserId: USER,
      conversationId: 'own-chat',
      title: 'Mine',
      source: 'app',
      agentId: ALIA_GEMIE_ID,
    });
    const { conversationId } = await openGemieConversation(db, {
      oxyUserId: USER,
      fromAgentId: 'a',
      toAgentId: 'b',
      title: 'A · B',
    });
    const ids = async (kind?: 'person' | 'gemies') =>
      (await listConversations(db, USER, 10, kind ? { kind } : {})).map((c) => c.conversationId);
    expect(await ids()).toEqual(['own-chat']);
    expect(await ids('gemies')).toEqual([conversationId]);

    await deleteConversation(db, USER, conversationId);
    expect(await ids('gemies')).toEqual([]);
    expect(await isGemieConversation(db, USER, conversationId)).toBe(false);
  });
});

describe('a chain of several turns, on Postgres', () => {
  it('stores the whole conversation, each gemie as itself, readable as the view reads it', async () => {
    await createConversation(db, {
      oxyUserId: USER,
      conversationId: 'chat',
      title: 'Pisos',
      source: 'app',
      agentId: PEPE.id,
    });
    const { conversationId } = await openGemieConversation(db, {
      oxyUserId: USER,
      fromAgentId: PEPE.id,
      toAgentId: LUMEN.id,
      title: 'Pepe · Lumen',
    });
    const real = roomRuntime().deps;
    const events: RoomEvent[] = [];
    const queue: GemieStepData[] = [];
    let pepeTurns = 0;
    const room: RoomEngineDeps = {
      ...real,
      publish: (event) => {
        events.push(event);
      },
      revokeTasks: async () => undefined,
      loadAgent: async (id) => ({ _id: id }) as Awaited<ReturnType<RoomEngineDeps['loadAgent']>>,
      runTurn: async (turn) => {
        if (turn.agent._id === LUMEN.id) {
          const said = JSON.parse(turn.task.slice(turn.task.lastIndexOf('): ') + 3)) as string;
          return { response: `About "${said}": yes.`, tokensUsed: 10, creditsCharged: 1 };
        }
        pepeTurns += 1;
        if (pepeTurns < 3) {
          const sent = await turn.gemieChain!.deliver(`Follow-up ${pepeTurns}`);
          expect(sent).toEqual({ conversationId, chainId: 'pg-chain' });
          return { response: '', tokensUsed: 10, creditsCharged: 1 };
        }
        return { response: 'Lumen and I agree: take it.', tokensUsed: 10, creditsCharged: 1 };
      },
    };
    await real.storeReply({
      userId: USER,
      conversationId,
      clientMessageId: gemieMessageIdOf('pg-chain', 0),
      content: 'Is the flat a good deal?',
      agentInfo: PEPE,
    });
    queue.push({
      kind: 'gemies',
      phase: 'reply',
      userId: USER,
      conversationId,
      originConversationId: 'chat',
      chainId: 'pg-chain',
      triggerId: gemieMessageIdOf('pg-chain', 0),
      initiator: { info: PEPE },
      recipient: { info: LUMEN },
      turn: 1,
      messages: 1,
      tokens: 0,
      surfaceApplicationId: null,
    });
    const deps = {
      room,
      enqueue: async (job: GemieStepData) => {
        queue.push(job);
      },
      bounds: DEFAULT_GEMIE_CHAIN_BOUNDS,
    };
    for (let job = queue.shift(); job; job = queue.shift()) await processGemieStep(job, deps);

    const between = (await listMessages(db, USER, conversationId)).map(toStoredMessage);
    expect(between.map((m) => [m.agentInfo?.name, m.role, m.content])).toEqual([
      ['Pepe', 'assistant', 'Is the flat a good deal?'],
      ['Lumen', 'assistant', 'About "Is the flat a good deal?": yes.'],
      ['Pepe', 'assistant', 'Follow-up 1'],
      ['Lumen', 'assistant', 'About "Follow-up 1": yes.'],
      ['Pepe', 'assistant', 'Follow-up 2'],
      ['Lumen', 'assistant', 'About "Follow-up 2": yes.'],
    ]);
    expect(between.map((m) => m.agentInfo?.id)).toEqual([
      PEPE.id,
      LUMEN.id,
      PEPE.id,
      LUMEN.id,
      PEPE.id,
      LUMEN.id,
    ]);
    expect(new Set(between.map((m) => m.id)).size).toBe(6);
    // The person's chat holds what Pepe told them, as Pepe's own reply.
    const chat = (await listMessages(db, USER, 'chat')).map(toStoredMessage);
    expect(chat.map((m) => [m.role, m.content, m.agentInfo])).toEqual([
      ['assistant', 'Lumen and I agree: take it.', undefined],
    ]);
    // Its preview and the conversation between gemies moved with what was said.
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.oxyUserId, USER), eq(conversations.conversationId, conversationId)),
      );
    expect(row?.lastMessage).toBe('About "Follow-up 2": yes.');
    expect(events.filter((e) => e.event === 'group.idle')).toHaveLength(2);
  });
});

describe('0171: consultations become conversations between gemies', () => {
  const MIGRATION = fileURLToPath(
    new URL('../../../drizzle/0171_consultations_become_gemie_conversations.sql', import.meta.url),
  );
  const replay = () =>
    db.transaction(async (tx) => {
      for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
        await tx.execute(sql.raw(statement));
      }
    });
  const consult = (id: string, agentId: string, task: string, result: Record<string, unknown>) => ({
    toolCallId: id,
    toolName: 'consultAgent',
    state: 'result',
    args: { agentId, task },
    result,
  });

  it('moves every answered consultation, keeps a failed one as an error, and is idempotent', async () => {
    await createConversation(db, {
      oxyUserId: USER,
      conversationId: 'alia-chat',
      title: 'Hola',
      source: 'app',
      agentId: ALIA_GEMIE_ID,
    });
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s));
    await insertMessages(db, [
      {
        oxyUserId: USER,
        conversationId: 'alia-chat',
        clientMessageId: 'u-1',
        role: 'user',
        content: 'Ask Lumen and Sindi',
        seq: 0,
        createdAt: at(0),
      },
      {
        oxyUserId: USER,
        conversationId: 'alia-chat',
        clientMessageId: 'a-1',
        role: 'assistant',
        content: 'Both answered.',
        seq: 1,
        createdAt: at(1),
        toolInvocations: [
          consult('c1', LUMEN.id, 'Is it fair?', {
            agentId: LUMEN.id,
            agentName: 'Lumen',
            agentHandle: 'lumen',
            agentColor: null,
            agentCharacter: null,
            response: 'Yes, fair.',
          }),
          consult('c2', 'sindi-0170', 'Any flats?', {
            agentId: 'sindi-0170',
            agentName: 'Unknown',
            response: '',
            error: 'Agent not found',
          }),
          { toolCallId: 'w', toolName: 'webSearch', state: 'result', args: {}, result: {} },
        ] as never,
      },
      {
        oxyUserId: USER,
        conversationId: 'alia-chat',
        clientMessageId: 'a-1-agent-0',
        role: 'assistant',
        content: 'Yes, fair.',
        seq: 2,
        createdAt: at(1),
        agentInfo: LUMEN,
      },
      // An answer whose call was not kept.
      {
        oxyUserId: USER,
        conversationId: 'alia-chat',
        clientMessageId: 'gone-agent-0',
        role: 'assistant',
        content: 'An older answer.',
        seq: 3,
        createdAt: at(0),
        agentInfo: LUMEN,
      },
    ]);

    await replay();
    await replay();

    const [pair] = await db
      .select()
      .from(gemieConversations)
      .where(eq(gemieConversations.oxyUserId, USER));
    expect(pair).toBeDefined();
    const between = (await listMessages(db, USER, pair!.conversationId)).map(toStoredMessage);
    expect(between.map((m) => [m.agentInfo?.id, m.content])).toEqual([
      [LUMEN.id, 'An older answer.'],
      [ALIA_GEMIE_ID, 'Is it fair?'],
      [LUMEN.id, 'Yes, fair.'],
    ]);
    expect(between[1]?.agentInfo?.name).toBe('Alia');

    const chat = (await listMessages(db, USER, 'alia-chat')).map(toStoredMessage);
    expect(chat.map((m) => m.id)).toEqual(['u-1', 'a-1']);
    const calls = chat[1]?.toolInvocations ?? [];
    expect(calls.map((c) => c.toolName)).toEqual(['sendMessage', 'sendMessage', 'webSearch']);
    expect(calls[0]).toMatchObject({
      args: { to: LUMEN.id, text: 'Is it fair?' },
      result: {
        status: 'sent',
        conversationId: pair!.conversationId,
        from: { id: ALIA_GEMIE_ID, name: 'Alia' },
        to: { id: LUMEN.id, name: 'Lumen' },
      },
    });
    expect(calls[1]).toMatchObject({ result: { error: 'Agent not found' } });
    expect(await listGroupMembers(db, USER, pair!.conversationId)).toEqual([
      ALIA_GEMIE_ID,
      LUMEN.id,
    ]);
  });
});
