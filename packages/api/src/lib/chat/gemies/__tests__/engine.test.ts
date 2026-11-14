/**
 * A conversation between gemies, step by step (ADR 0042), on in-memory doubles of the room's world:
 * a gemie writes, the other answers in its own turn, the first reads the answer in its chat with the
 * person and writes again or tells the person. The stored conversation is the record; the bus only
 * makes it live; the bounds belong to the chain.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, ToolInvocation } from '../../../../domain/conversation.js';
import type { AgentTurnResult } from '../../../tools/agent-turn.js';
import type { RoomEvent } from '../../room/bus.js';
import type { RoomEngineDeps, TranscriptRow } from '../../room/engine.js';
import { type GemieStepData, abandonGemieChain, processGemieStep } from '../engine.js';
import { DEFAULT_GEMIE_CHAIN_BOUNDS, gemieMessageIdOf } from '../policy.js';
import { createLocalRoomLock } from '../../room/lock.js';

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
type Script = (turn: Turn) => Promise<{
  text: string;
  write?: string;
  error?: string;
  canvas?: ToolInvocation[];
  reactionOnly?: true;
}>;

function world(script: Record<string, Script>, bounds = DEFAULT_GEMIE_CHAIN_BOUNDS) {
  const store = new Map<string, TranscriptRow[]>();
  const events: RoomEvent[] = [];
  const queue: GemieStepData[] = [];
  const turns: Turn[] = [];
  const stores: Array<Parameters<RoomEngineDeps['storeReply']>[0]> = [];
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
        ...(done.reactionOnly ? { reactionOnly: true } : {}),
        ...(done.error ? { error: done.error } : {}),
        ...(done.canvas ? { canvas: done.canvas } : {}),
      } as AgentTurnResult;
    },
    storeReply: async (input) => {
      stores.push(input);
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
        // Under its own name, as a gemie's post in its chat is.
        agentInfo: PEPE,
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
      initiator: { info: PEPE },
      recipient: { info: LUMEN },
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
  return { store, events, queue, turns, stores, deps, start, drain, said, rowsOf };
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
    expect(w.said('chat')).toEqual(['Pepe: Lumen says it fits two, and the rent is fair.']);
    // Both conversations are told the chain is over.
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
    // Acting for the person on Gemies' own authority (oxy ADR 0066): no task, no bearer.
    expect(lumen.person).toEqual({
      oxyUserId: 'person',
      isDirectSession: false,
      surfaceApplicationId: null,
    });
    expect(lumen.payerOxyUserId).toBe('person');

    const pepe = w.turns.find((turn) => turn.agent._id === 'pepe')!;
    expect(pepe.gemieChain?.peerId).toBe('lumen');
    expect(pepe.person).toMatchObject({ oxyUserId: 'person', isDirectSession: false });
    expect(pepe.person).not.toHaveProperty('taskId');
    expect(JSON.parse(pepe.task.slice(pepe.task.indexOf('['))) as unknown).toEqual([
      { from: 'you', text: 'Hello?', reactions: [] },
      { from: 'Lumen', text: 'Fine.', reactions: [] },
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

describe('what a turn of the chain keeps', () => {
  it('stores the canvas the answering gemie drew with its words', async () => {
    const canvas: ToolInvocation = {
      toolCallId: 'c1',
      toolName: 'canvas',
      state: 'result',
      args: { type: 'markdown', title: 'Pisos' },
      result: { type: 'markdown', title: 'Pisos', data: { content: '# Gràcia' } },
    };
    const w = world({
      lumen: async () => ({ text: 'Here is the table.', canvas: [canvas] }),
      pepe: async () => ({ text: 'Done.' }),
    });
    await w.start('Make me a table');
    await w.drain();
    expect(w.stores.find((input) => input.agentInfo.id === 'lumen')?.toolInvocations).toEqual([
      canvas,
    ]);
  });

  it('keeps the person’s personalization off on every turn of the chain', async () => {
    const w = world({ lumen: async () => ({ text: 'x' }), pepe: async () => ({ text: 'y' }) });
    await w.start('Hello?');
    w.queue[0] = { ...w.queue[0]!, personalization: false };
    await w.drain();
    expect(w.turns.map((turn) => turn.person.personalization)).toEqual([false, false]);
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
    expect(w.said('chat')).toEqual(['Pepe: Here is what I have.']);
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
    expect(w.said('chat')).toEqual(['Pepe: Enough.']);
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
    expect(w.said('chat')).toEqual(['Pepe: Lumen could not answer.']);
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

  it('an abandoned chain stops showing anyone at work', async () => {
    const w = world({});
    await w.start('Hello?');
    await abandonGemieChain(w.queue[0]!, w.deps);
    expect(w.events.map((event) => [event.conversationId, event.event, event.data.reason])).toEqual(
      [
        ['between', 'group.idle', 'error'],
        ['chat', 'group.idle', 'error'],
      ],
    );
  });
});

describe('peer reactions within an already admitted chain', () => {
  it('continues once with attributed feedback and counts a quiet recipient contribution without an empty row', async () => {
    const w = world({
      lumen: async () => {
        const row = w.rowsOf('between')[0]!;
        w.rowsOf('between')[0] = {
          ...row,
          reactionEntries: [
            { emoji: '❤️', author: { kind: 'agent', id: LUMEN.id, name: LUMEN.name } },
          ],
        };
        return { text: '', reactionOnly: true };
      },
      pepe: async (turn) => {
        expect(turn.task).toContain('"emoji":"❤️"');
        expect(turn.task).toContain('"kind":"agent"');
        // Receiving only a reaction does not grant a capability to react back.
        expect(turn.conversationReaction).toBeUndefined();
        return { text: '' };
      },
    });
    const prepare = vi.fn<NonNullable<RoomEngineDeps['prepareReaction']>>(async () => undefined);
    const deps = { ...w.deps, room: { ...w.deps.room, prepareReaction: prepare } };
    await w.start('Gracias por comprobarlo.');
    expect(await processGemieStep(w.queue.shift()!, deps)).toBe('continued');
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'between',
      allowedActorIds: ['lumen'],
      trigger: {
        kind: 'peer',
        chainId: 'chain',
        message: {
          id: 'gemie-message-chain-0',
          content: 'Gracias por comprobarlo.',
          actorId: 'pepe',
        },
      },
    });
    expect(w.queue[0]?.messages).toBe(2);
    expect(await processGemieStep(w.queue.shift()!, deps)).toBe('ended');
    expect(w.queue).toEqual([]);
    expect(w.said('between')).toHaveLength(1);
    expect(w.said('chat')).toEqual([]);
    expect(w.events).toContainEqual(
      expect.objectContaining({
        conversationId: 'between',
        event: 'alia.agent_end',
        data: expect.objectContaining({ status: 'completed', reactionOnly: true }),
      }),
    );
  });

  it('replays a durable recipient reaction after lost enqueue without another inference or double count', async () => {
    let completed = false;
    const w = world(
      {
        lumen: async () => {
          completed = true;
          return { text: '', reactionOnly: true };
        },
        pepe: async (turn) => {
          expect(turn.conversationReaction).toBeUndefined();
          expect(turn.gemieChain).toBeUndefined();
          return { text: 'Hecho.' };
        },
      },
      { maxMessages: 8, maxTokens: 107 },
    );
    await w.start('Gracias.');
    const job = { ...w.queue.shift()!, tokens: 7 };
    const replay = vi.fn(async () => undefined);
    const prepare = vi.fn<NonNullable<RoomEngineDeps['prepareReaction']>>(async () => undefined);
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error('Queue unavailable'))
      .mockImplementation(w.deps.enqueue);
    const deps = {
      ...w.deps,
      enqueue,
      room: {
        ...w.deps.room,
        // Release A can read a release B receipt with new authoring unavailable.
        prepareReaction: prepare,
        reactionCompletion: async () => (completed ? { tokensUsed: 100 } : null),
        replayReactions: replay,
      },
    };
    await expect(processGemieStep(job, deps)).rejects.toThrow('Queue unavailable');
    prepare.mockClear();
    expect(await processGemieStep(job, deps)).toBe('continued');
    expect(w.turns).toHaveLength(1);
    expect(replay).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(w.queue).toHaveLength(1);
    expect(w.queue[0]).toMatchObject({ phase: 'continue', messages: 2, tokens: 107 });
    expect(w.said('between')).toHaveLength(1);
    expect(await processGemieStep(w.queue.shift()!, deps)).toBe('ended');
    expect(w.queue).toHaveLength(0);
  });

  it('lets the initiator react to a textual peer reply in the pair, then ends without another message', async () => {
    const w = world({
      lumen: async () => ({ text: 'Hecho.' }),
      pepe: async () => ({ text: '', reactionOnly: true }),
    });
    const prepare = vi.fn<NonNullable<RoomEngineDeps['prepareReaction']>>(async () => undefined);
    const deps = { ...w.deps, room: { ...w.deps.room, prepareReaction: prepare } };
    await w.start('Comprueba el enlace.');
    await processGemieStep(w.queue.shift()!, deps);
    const continuation = w.queue.shift()!;
    expect(await processGemieStep(continuation, deps)).toBe('ended');
    expect(prepare.mock.calls[1]?.[0]).toMatchObject({
      conversationId: 'between',
      allowedActorIds: ['pepe'],
      trigger: { kind: 'peer', message: { actorId: 'lumen', content: 'Hecho.' } },
    });
    expect(w.said('between')).toHaveLength(2);
    expect(w.said('chat')).toEqual([]);
    expect(w.queue).toEqual([]);
    const replay = vi.fn(async () => undefined);
    await processGemieStep(continuation, {
      ...deps,
      room: {
        ...deps.room,
        reactionCompletion: async () => ({ tokensUsed: 100 }),
        replayReactions: replay,
      },
    });
    expect(replay).toHaveBeenCalledOnce();
    expect(w.turns).toHaveLength(2);
    expect(w.events).toContainEqual(
      expect.objectContaining({
        conversationId: 'chat',
        event: 'alia.agent_end',
        data: expect.objectContaining({ reactionOnly: true }),
      }),
    );
  });
});

describe('peer reaction contribution bounds', () => {
  it.each(['rate', 'messages', 'tokens'] as const)(
    'withholds a new continuation reaction when the reply fills the %s budget',
    async (boundary) => {
      const bounds = {
        maxMessages: boundary === 'messages' ? 2 : 8,
        maxTokens: boundary === 'tokens' ? 100 : 120_000,
      };
      const w = world(
        {
          lumen: async () => ({ text: 'Hecho.' }),
          pepe: async () => ({ text: 'Ya está comprobado.' }),
        },
        bounds,
      );
      const prepare = vi.fn<NonNullable<RoomEngineDeps['prepareReaction']>>(async () => undefined);
      let recent = boundary === 'rate' ? 59 : 0;
      const keys: string[] = [];
      const deps = {
        ...w.deps,
        room: {
          ...w.deps.room,
          prepareReaction: prepare,
          repliesSince: async () => recent,
          lock: {
            run: <T>(key: string, work: () => Promise<T>) => {
              keys.push(key);
              return work();
            },
          },
        },
      };
      await w.start('Comprueba el enlace.');
      await processGemieStep(w.queue.shift()!, deps);
      if (boundary === 'rate') recent = 60;
      const continuation = w.queue.shift()!;
      expect(await processGemieStep(continuation, deps)).toBe('ended');
      expect(prepare).toHaveBeenCalledTimes(1); // Recipient had the final slot; continuation has none.
      expect(w.said('chat')).toEqual(['Pepe: Ya está comprobado.']);
      expect(keys.slice(-2)).toEqual(['person:between', 'person:chat']);
      // A completed contribution is historical delivery, so replay remains possible at the limit.
      const replay = vi.fn(async () => undefined);
      w.rowsOf('chat').length = 0;
      const turns = w.turns.length;
      expect(
        await processGemieStep(continuation, {
          ...deps,
          room: {
            ...deps.room,
            reactionCompletion: async () => ({ tokensUsed: 100 }),
            replayReactions: replay,
          },
        }),
      ).toBe('ended');
      expect(replay).toHaveBeenCalledOnce();
      expect(w.turns).toHaveLength(turns);
    },
  );

  it('deduplicates equal lock scopes and admits no reply when the chain is already full', async () => {
    const w = world(
      { lumen: async () => ({ text: 'Never runs' }), pepe: async () => ({ text: '' }) },
      { maxMessages: 1, maxTokens: 100 },
    );
    const keys: string[] = [];
    const deps = {
      ...w.deps,
      room: {
        ...w.deps.room,
        lock: {
          run: <T>(key: string, work: () => Promise<T>) => {
            keys.push(key);
            return work();
          },
        },
      },
    };
    await w.start('Gracias.');
    await processGemieStep(w.queue.shift()!, deps);
    expect(w.turns).toHaveLength(0);
    const continuation = { ...w.queue.shift()!, originConversationId: 'between' };
    await processGemieStep(continuation, deps);
    expect(keys).toEqual(['person:between', 'person:between']);
    expect(w.said('between')).toHaveLength(1);
  });
});

it('serializes continuations from different origins before testing the last peer reaction slot', async () => {
  let recent = 59,
    entered!: () => void,
    release!: () => void,
    runs = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const w = world({
    lumen: async () => ({ text: 'Hecho.' }),
    pepe: async () => {
      runs++;
      if (runs === 1) {
        entered();
        await gate;
        recent++;
        return { text: '', reactionOnly: true };
      }
      return { text: 'He recibido la respuesta.' };
    },
  });
  await w.start('Comprueba el enlace.');
  await processGemieStep(w.queue.shift()!, w.deps);
  const continuation = w.queue.shift()!;
  const prepare = vi.fn<NonNullable<RoomEngineDeps['prepareReaction']>>(async () => undefined);
  const deps = {
    ...w.deps,
    room: {
      ...w.deps.room,
      lock: createLocalRoomLock(),
      prepareReaction: prepare,
      repliesSince: async () => recent,
    },
  };
  const first = processGemieStep(continuation, deps);
  await ready;
  const second = processGemieStep(
    { ...continuation, originConversationId: 'another-chat', turn: continuation.turn + 1 },
    deps,
  );
  release();
  expect(await Promise.all([first, second])).toEqual(['ended', 'ended']);
  expect(prepare).toHaveBeenCalledOnce();
  expect(runs).toBe(2);
  expect(recent).toBe(60);
});
