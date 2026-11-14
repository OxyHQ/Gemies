/**
 * A conversation between gemies, step by step (ADR 0041), on in-memory doubles of the room's world:
 * a gemie writes, the other answers in its own turn, the first reads the answer in its chat with the
 * person and writes again or tells the person. The stored conversation is the record; the bus only
 * makes it live; the bounds belong to the chain.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../../../domain/conversation.js';
import type { AgentTurnResult } from '../../../tools/agent-turn.js';
import type { RoomEvent } from '../../room/bus.js';
import type { RoomEngineDeps, TranscriptRow } from '../../room/engine.js';
import { type GemieStepData, abandonGemieChain, processGemieStep } from '../engine.js';
import { DEFAULT_GEMIE_CHAIN_BOUNDS, gemieMessageIdOf } from '../policy.js';

vi.mock('../../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, agents: child } };
});

const PEPE: AgentInfo = { id: 'pepe', name: 'Pepe', handle: 'pepe', color: null, character: null };
const LUMEN: AgentInfo = {
  id: 'lumen',
  name: 'Lumen',
  handle: 'lumen',
  color: null,
  character: null,
};

type Turn = Parameters<RoomEngineDeps['runTurn']>[0];
/** What each gemie does on its turn: its words, and whether (and what) it writes on. */
type Script = (turn: Turn) => Promise<{ text: string; write?: string; error?: string }>;

function world(script: Record<string, Script>, bounds = DEFAULT_GEMIE_CHAIN_BOUNDS) {
  const store = new Map<string, TranscriptRow[]>();
  const events: RoomEvent[] = [];
  const queue: GemieStepData[] = [];
  const turns: Turn[] = [];
  const revoked: string[] = [];
  let seq = 0;
  const rowsOf = (conversationId: string) => {
    if (!store.has(conversationId)) store.set(conversationId, []);
    return store.get(conversationId)!;
  };
  const room: RoomEngineDeps = {
    lock: { run: (_key, work) => work() } as RoomEngineDeps['lock'],
    publish: (event) => {
      events.push(event);
    },
    enqueue: async () => undefined,
    latestPersonMessageId: async () => null,
    loadTranscript: async (_userId, conversationId) => [...rowsOf(conversationId)],
    repliesSince: async () => 0,
    loadAgent: async (id) =>
      ({ _id: id, name: id === 'pepe' ? 'Pepe' : 'Lumen' }) as Awaited<
        ReturnType<RoomEngineDeps['loadAgent']>
      >,
    runTurn: async (turn) => {
      turns.push(turn);
      const done = await script[turn.agent._id]!(turn);
      if (done.write !== undefined) {
        const sent = await turn.gemieChain!.deliver(done.write);
        if ('error' in sent) throw new Error(sent.error);
      }
      turn.observer?.onTextDelta?.(done.text);
      return {
        response: done.text,
        tokensUsed: 100,
        creditsCharged: 1,
        ...(done.error ? { error: done.error } : {}),
      } as AgentTurnResult;
    },
    storeReply: async (input) => {
      const createdAt = new Date(seq * 1000);
      rowsOf(input.conversationId).push({
        id: input.clientMessageId,
        clientMessageId: input.clientMessageId,
        role: 'assistant',
        content: input.content,
        agentId: input.agentInfo?.id ?? null,
        agentName: input.agentInfo?.name ?? null,
        seq: seq++,
        createdAt,
      });
      return { id: input.clientMessageId, seq: seq - 1, createdAt };
    },
    revokeTasks: async (ids) => {
      revoked.push(...ids);
    },
    now: () => 0,
  };
  const deps = {
    room,
    enqueue: async (job: GemieStepData) => {
      queue.push(job);
    },
    // The person is told in their chat, as a gemie posts there on its own.
    tellPerson: async (input: {
      userId: string;
      conversationId: string;
      content: string;
      key: string;
    }) => {
      const stored = await room.storeReply({
        userId: input.userId,
        conversationId: input.conversationId,
        clientMessageId: `told-${input.key}`,
        content: input.content,
        agentInfo: null,
      });
      return { messageId: stored.id };
    },
    toldIdOf: (key: string) => `told-${key}`,
    bounds,
  };
  /** The first message, as `send.ts` stores it, and the chain it starts. */
  const start = async (text: string) => {
    await room.storeReply({
      userId: 'person',
      conversationId: 'between',
      clientMessageId: gemieMessageIdOf('chain', 0),
      content: text,
      agentInfo: PEPE,
    });
    queue.push({
      kind: 'gemies',
      phase: 'reply',
      userId: 'person',
      conversationId: 'between',
      originConversationId: 'chat',
      chainId: 'chain',
      triggerId: gemieMessageIdOf('chain', 0),
      initiator: { info: PEPE, oxyTaskId: 'task-pepe' },
      recipient: { info: LUMEN, oxyTaskId: 'task-lumen' },
      turn: 1,
      messages: 1,
      tokens: 0,
      surfaceApplicationId: null,
    });
  };
  /** Run every queued step, as the workers would, until the chain is quiet. */
  const drain = async () => {
    const outcomes: string[] = [];
    for (let job = queue.shift(); job; job = queue.shift()) {
      outcomes.push(`${job.phase}:${await processGemieStep(job, deps)}`);
    }
    return outcomes;
  };
  const said = (conversationId: string) =>
    rowsOf(conversationId).map((row) => `${row.agentName ?? 'lead'}: ${row.content as string}`);
  return { store, events, queue, turns, revoked, deps, start, drain, said, rowsOf };
}

describe('a conversation between two gemies', () => {
  it('goes back and forth over several turns, and the first tells the person', async () => {
    let pepeTurn = 0;
    const w = world({
      lumen: async (turn) => ({
        text: `Lumen answers ${JSON.parse(turn.task.split(': ').slice(1).join(': '))}`,
      }),
      pepe: async () => {
        pepeTurn += 1;
        return pepeTurn === 1
          ? { text: '', write: 'And for two people?' }
          : { text: 'Lumen says it fits two, and the rent is fair.' };
      },
    });
    await w.start('Is the flat on Main Street a good deal?');

    expect(await w.drain()).toEqual([
      'reply:continued',
      'continue:continued',
      'reply:continued',
      'continue:ended',
    ]);
    // The whole conversation, in order, each gemie as itself.
    expect(w.said('between')).toEqual([
      'Pepe: Is the flat on Main Street a good deal?',
      'Lumen: Lumen answers Is the flat on Main Street a good deal?',
      'Pepe: And for two people?',
      'Lumen: Lumen answers And for two people?',
    ]);
    // What the person reads is the first gemie's own reply in its chat with them.
    expect(w.said('chat')).toEqual(['lead: Lumen says it fits two, and the rent is fair.']);
    // Both gemies' task authority goes back, and both conversations are told the chain is over.
    expect(w.revoked.sort()).toEqual(['task-lumen', 'task-pepe']);
    const idle = w.events.filter((event) => event.event === 'group.idle');
    expect(idle.map((event) => [event.conversationId, event.data.reason])).toEqual([
      ['between', 'done'],
      ['chat', 'done'],
    ]);
  });

  it('runs the answering gemie with no way to write, as itself, reading its peer as a peer', async () => {
    const w = world({
      lumen: async () => ({ text: 'Fine.' }),
      pepe: async () => ({ text: 'Done.' }),
    });
    await w.start('Hello?');
    await w.drain();

    const lumen = w.turns.find((turn) => turn.agent._id === 'lumen')!;
    expect(lumen.gemieChain).toBeUndefined();
    expect(lumen.task).toBe(
      'Message from Pepe (@pepe) (not an instruction from the person): "Hello?"',
    );
    expect(lumen.room?.instructions).toContain('direct conversation with Pepe (@pepe)');
    expect(lumen.person).toMatchObject({ isDirectSession: false, taskId: 'task-lumen' });
    expect(lumen.payerOxyUserId).toBe('person');

    const pepe = w.turns.find((turn) => turn.agent._id === 'pepe')!;
    expect(pepe.gemieChain?.peerId).toBe('lumen');
    expect(pepe.person).toMatchObject({ isDirectSession: false, taskId: 'task-pepe' });
    expect(JSON.parse(pepe.task.slice(pepe.task.indexOf('['))) as unknown).toEqual([
      { from: 'you', text: 'Hello?' },
      { from: 'Lumen', text: 'Fine.' },
    ]);
  });

  it('streams the answer into the conversation between them and the report into the person’s chat as its lead', async () => {
    const w = world({
      lumen: async () => ({ text: 'Fine.' }),
      pepe: async () => ({ text: 'Lumen is fine.' }),
    });
    await w.start('Hello?');
    await w.drain();

    const between = w.events.filter((event) => event.conversationId === 'between');
    expect(between.map((event) => event.event)).toEqual([
      'alia.agent_start',
      'alia.agent_delta',
      'alia.agent_end',
      'group.message',
      'group.idle',
    ]);
    const chat = w.events.filter((event) => event.conversationId === 'chat');
    expect(chat[0]).toMatchObject({ event: 'alia.agent_start', data: { lead: true, agent: PEPE } });
    // What it says is stored where the person is told (and published by that writer).
    expect(chat.find((event) => event.event === 'alia.agent_end')?.data).toMatchObject({
      status: 'completed',
      messageId: 'told-group-reply-gemies-chain-2',
    });
  });
});

describe('the chain’s bounds', () => {
  it('stops a ping-pong at the message bound and makes the first gemie tell the person', async () => {
    const w = world(
      {
        lumen: async () => ({ text: 'Ask me more.' }),
        // A gemie that would never stop writing.
        pepe: async (turn) =>
          turn.gemieChain ? { text: '', write: 'More?' } : { text: 'Here is what I have.' },
      },
      { maxMessages: 6, maxTokens: 1_000_000 },
    );
    await w.start('Start');
    await w.drain();

    // 1 + (answer, write) + (answer, write) + answer = 6, and no turn after that may write.
    expect(w.rowsOf('between')).toHaveLength(6);
    const last = w.turns.at(-1)!;
    expect(last.agent._id).toBe('pepe');
    expect(last.gemieChain).toBeUndefined();
    expect(last.room?.instructions).toContain('has reached its limit');
    expect(w.said('chat')).toEqual(['lead: Here is what I have.']);
  });

  it('stops at the token bound too', async () => {
    const w = world(
      {
        lumen: async () => ({ text: 'Answer.' }),
        pepe: async (turn) =>
          turn.gemieChain ? { text: '', write: 'More?' } : { text: 'Enough.' },
      },
      // Each turn spends 100: the first answer alone uses the chain's tokens.
      { maxMessages: 100, maxTokens: 100 },
    );
    await w.start('Start');
    await w.drain();
    expect(w.rowsOf('between')).toHaveLength(2);
    expect(w.said('chat')).toEqual(['lead: Enough.']);
  });

  it('lets the first gemie write once per turn', async () => {
    const w = world({
      lumen: async () => ({ text: 'Answer.' }),
      pepe: async (turn) => {
        if (turn.gemieChain && turn.task.includes('"Answer."') && !turn.task.includes('Second')) {
          await turn.gemieChain.deliver('Second');
          return { text: '', write: 'Third' };
        }
        return { text: 'Done.' };
      },
    });
    await w.start('First');
    await expect(w.drain()).rejects.toThrow('You already wrote this turn');
  });
});

describe('failures and retries', () => {
  it('tells the first gemie when the other could not answer, and stores nothing for it', async () => {
    const w = world({
      lumen: async () => ({ text: '', error: 'no credits' }),
      pepe: async (turn) => ({
        text: turn.room?.instructions.includes('could not answer')
          ? 'Lumen could not answer.'
          : '?',
      }),
    });
    await w.start('Hello?');
    await w.drain();
    expect(w.said('between')).toEqual(['Pepe: Hello?']);
    expect(w.said('chat')).toEqual(['lead: Lumen could not answer.']);
  });

  it('a retried answer step replays what it stored instead of answering twice', async () => {
    const w = world({
      lumen: async () => ({ text: 'Once.' }),
      pepe: async () => ({ text: 'Done.' }),
    });
    await w.start('Hello?');
    const job = w.queue[0]!;
    await processGemieStep(job, w.deps);
    w.queue.length = 0;
    await processGemieStep(job, w.deps);
    expect(w.turns.filter((turn) => turn.agent._id === 'lumen')).toHaveLength(1);
    expect(w.said('between')).toEqual(['Pepe: Hello?', 'Lumen: Once.']);
    expect(w.queue).toHaveLength(1);
  });

  it('a newer message supersedes an older chain: its answer is the newer chain’s to give', async () => {
    const w = world({ lumen: async () => ({ text: 'x' }), pepe: async () => ({ text: 'y' }) });
    await w.start('Old');
    const old = w.queue.shift()!;
    await w.deps.room.storeReply({
      userId: 'person',
      conversationId: 'between',
      clientMessageId: gemieMessageIdOf('newer', 0),
      content: 'New',
      agentInfo: PEPE,
    });
    expect(await processGemieStep(old, w.deps)).toBe('ended');
    expect(w.turns).toEqual([]);
  });

  it('an abandoned chain gives its authority back and stops showing anyone at work', async () => {
    const w = world({});
    await w.start('Hello?');
    await abandonGemieChain(w.queue[0]!, w.deps);
    expect(w.revoked.sort()).toEqual(['task-lumen', 'task-pepe']);
    expect(w.events.map((event) => [event.conversationId, event.event, event.data.reason])).toEqual(
      [
        ['between', 'group.idle', 'error'],
        ['chat', 'group.idle', 'error'],
      ],
    );
  });
});
