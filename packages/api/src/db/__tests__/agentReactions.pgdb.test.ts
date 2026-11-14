import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { conversationMembers, gemieConversations, messages } from '../schema/chat';
import {
  agentReactionTurns,
  messageReactionStates,
  reactionEvents,
} from '../schema/message-reactions';
import { createGroupConversation } from '../chat/conversationMemberRepository';
import { createConversation, deleteConversation } from '../chat/conversationRepository';
import {
  insertMessages,
  listMessages,
  replaceMessages,
  toStoredMessage,
} from '../chat/messageRepository';
import {
  type AgentReactionTrigger,
  claimReactionEvents,
  findAgentReactionTurnComplete,
  listReactionContext,
  markAgentReactionTurnComplete,
  mutateAgentMessageReaction,
  mutateMessageReaction,
  ReactionMutationConflict,
  listAgentReactionTargets,
  listAgentReactionTurnSnapshots,
  listAgentReactionContributions,
  countAgentReactionTurnsSince,
} from '../chat/reactionRepository';
import { lockMessageThread } from '../chat/messageLock';
import { TEST_CHARACTER } from './support/agent-character';
import { ROOM_GEMIE_ID } from '../../domain/alia-gemie';
import { agentReactionTurnId } from '../../lib/chat/reactions/agent-tool';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Disposable Postgres required');
  db = connected;
});
afterAll(closePostgres);
async function fixture(direct = false) {
  const userId = randomUUID(),
    conversationId = randomUUID();
  const first = { id: randomUUID(), name: 'Eusebio' },
    second = { id: randomUUID(), name: 'Salella' };
  await db.insert(agents).values(
    [first, second].map((actor) => ({
      id: actor.id,
      oxyAccountId: randomUUID(),
      character: TEST_CHARACTER,
      tagline: 'Test',
      description: 'Test',
      authorOxyUserId: userId,
      category: 'assistant',
    })),
  );
  if (direct)
    await createConversation(db, {
      oxyUserId: userId,
      conversationId,
      title: 'Test',
      source: 'app',
      agentId: first.id,
    });
  else
    await createGroupConversation(db, {
      oxyUserId: userId,
      conversationId,
      title: 'Test',
      source: 'app',
      agentIds: [first.id, second.id],
    });
  await insertMessages(db, [
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'person',
      role: 'user',
      content: 'Gracias',
      seq: 0,
    },
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'peer',
      role: 'assistant',
      content: 'Listo',
      seq: 1,
      agentInfo: { ...second, handle: '', color: null, character: null },
    },
  ]);
  const react = (
    mutationId: string,
    active = true,
    emoji = '❤️',
    target = 'person',
    actor = first,
    turnId = 'admitted-turn',
  ) =>
    mutateAgentMessageReaction(db, userId, conversationId, target, {
      actor,
      turnId,
      trigger: { kind: 'person', message: { id: 'person', content: 'Gracias' } },
      expectedTarget: {
        content: target === 'person' ? 'Gracias' : 'Listo',
        role: target === 'person' ? 'user' : 'assistant',
        actorId: target === 'person' ? null : second.id,
      },
      mutationId,
      active,
      emoji,
    });
  return { userId, conversationId, first, second, react };
}

describe('authored agent reactions', () => {
  it('counts only scoped clean reaction-only completions within the reply-rate window', async () => {
    const f = await fixture();
    const since = new Date('2026-11-12T09:00:00Z');
    await f.react('receipt');
    expect(await countAgentReactionTurnsSince(db, f.userId, f.conversationId, new Date(0))).toBe(0);
    for (let retry = 0; retry < 3; retry++) {
      expect(
        await markAgentReactionTurnComplete(
          db,
          f.userId,
          f.conversationId,
          f.first.id,
          'admitted-turn',
          { kind: 'person', message: { id: 'person', content: 'Gracias' } },
        ),
      ).toBe(true);
    }
    await db
      .update(agentReactionTurns)
      .set({ completedAt: since })
      .where(eq(agentReactionTurns.oxyUserId, f.userId));
    // A successful mutation in a text-producing or unfinished turn is not a second contribution.
    await f.react('mixed', true, '👍', 'person', f.first, 'text-turn');
    expect(await countAgentReactionTurnsSince(db, f.userId, f.conversationId, since)).toBe(1);
    expect(
      await countAgentReactionTurnsSince(
        db,
        f.userId,
        f.conversationId,
        new Date(since.getTime() + 1),
      ),
    ).toBe(0);
    expect(await countAgentReactionTurnsSince(db, 'stranger', f.conversationId, new Date(0))).toBe(
      0,
    );
    expect(await countAgentReactionTurnsSince(db, f.userId, 'other-thread', new Date(0))).toBe(0);
  });

  it('replays the completed turn receipt targets outside the recent window with current snapshots', async () => {
    const f = await fixture();
    await f.react('old-person');
    await f.react('old-peer', true, '👍', 'peer');
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
        { kind: 'person', message: { id: 'person', content: 'Gracias' } },
      ),
    ).toBe(true);
    await insertMessages(
      db,
      Array.from({ length: 30 }, (_, index) => ({
        oxyUserId: f.userId,
        conversationId: f.conversationId,
        clientMessageId: `later-${index}`,
        role: 'assistant' as const,
        content: 'Later reply',
        seq: index + 2,
        agentInfo: { ...f.second, handle: '', color: null, character: null },
      })),
    );
    expect(
      (await listAgentReactionTargets(db, f.userId, f.conversationId)).some(
        (row) => row.id === 'person',
      ),
    ).toBe(false);
    await f.react('remove-old', false, '❤️', 'person', f.first, 'later-turn');
    const replay = await listAgentReactionTurnSnapshots(
      db,
      f.userId,
      f.conversationId,
      f.first.id,
      'admitted-turn',
    );
    expect(replay).toHaveLength(2);
    expect(replay.find((row) => row.messageId === 'person')).toMatchObject({
      reactions: [],
      reactionEntries: [],
      revision: 2,
      mutationId: 'admitted-turn',
    });
    expect(replay.find((row) => row.messageId === 'peer')?.reactionEntries).toEqual([
      { emoji: '👍', author: { kind: 'agent', ...f.first } },
    ]);
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        'stranger',
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toEqual([]);
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        f.userId,
        f.conversationId,
        f.second.id,
        'admitted-turn',
      ),
    ).toEqual([]);
    const stored = await listMessages(db, f.userId, f.conversationId);
    await replaceMessages(
      db,
      f.userId,
      f.conversationId,
      stored
        .filter((row) => row.clientMessageId !== 'person')
        .map((row) => ({
          clientMessageId: row.clientMessageId ?? row.id,
          role: row.role as 'assistant',
          content: row.content as string,
          agentInfo: {
            id: row.clientMessageId === 'peer' ? f.first.id : f.second.id,
            name: 'Replacement',
            handle: '',
            color: null,
            character: null,
          },
        })),
    );
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toEqual([]);
  });

  it('rejects mutations queued behind a newer user write and reused target authorship', async () => {
    const f = await fixture();
    let admit: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const newer = db.transaction(async (tx) => {
      await lockMessageThread(tx, f.userId, f.conversationId);
      entered();
      await gate;
      await insertMessages(tx, [
        {
          oxyUserId: f.userId,
          conversationId: f.conversationId,
          clientMessageId: 'next',
          role: 'user',
          content: 'Espera',
          seq: 2,
        },
      ]);
    });
    await ready;
    const stale = f.react('stale');
    admit();
    await newer;
    expect(await stale).toBeUndefined();
    const other = await fixture();
    await db
      .update(messages)
      .set({ agentInfoId: randomUUID() })
      .where(and(eq(messages.oxyUserId, other.userId), eq(messages.clientMessageId, 'peer')));
    expect(await other.react('wrong-author', true, '❤️', 'peer')).toBeUndefined();
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toEqual([]);
  });

  it('returns bounded owned target snapshots and direct actor attribution', async () => {
    const f = await fixture();
    const targets = await listAgentReactionTargets(db, f.userId, f.conversationId, 1);
    expect(targets).toEqual([
      expect.objectContaining({
        id: 'peer',
        role: 'assistant',
        content: 'Listo',
        agentInfoId: f.second.id,
        reactionEntries: [],
        revision: 0,
      }),
    ]);
    expect(await listAgentReactionTargets(db, 'stranger', f.conversationId)).toEqual([]);
    const direct = await fixture(true);
    await db
      .update(messages)
      .set({ agentInfoId: null })
      .where(and(eq(messages.oxyUserId, direct.userId), eq(messages.clientMessageId, 'peer')));
    expect(
      (await listAgentReactionTargets(db, direct.userId, direct.conversationId, 1))[0].agentInfoId,
    ).toBe(direct.first.id);
    expect(await direct.react('own', true, '❤️', 'peer')).toBeUndefined();
  });

  it('does not replay a former user target onto an unattributed assistant replacement', async () => {
    const f = await fixture();
    await f.react('old-user');
    await replaceMessages(db, f.userId, f.conversationId, [
      { clientMessageId: 'person', role: 'assistant', content: 'Different author' },
    ]);
    await mutateMessageReaction(db, f.userId, f.conversationId, 'person', {
      emoji: '👍',
      active: true,
      mutationId: 'new-target',
    });
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toEqual([]);
  });

  it('keeps the same emoji independently for the person and two agents, with one snapshot revision', async () => {
    const f = await fixture();
    await mutateMessageReaction(db, f.userId, f.conversationId, 'person', {
      emoji: '❤️',
      active: true,
      mutationId: 'human',
    });
    await Promise.all([f.react('one'), f.react('two', true, '❤️', 'person', f.second)]);
    const [row] = await listMessages(db, f.userId, f.conversationId);
    expect(row.reactions).toEqual(['❤️']);
    expect(row.reactionRevision).toBe(3);
    expect(toStoredMessage(row).reactionEntries).toHaveLength(3);
    const removed = await mutateMessageReaction(db, f.userId, f.conversationId, 'person', {
      emoji: '❤️',
      active: false,
      mutationId: 'human-remove',
    });
    expect(removed?.reactions).toEqual([]);
    expect(removed?.reactionEntries).toHaveLength(2);
    const ownRemoved = await f.react('remove', false);
    expect(ownRemoved?.reactionEntries).toEqual([
      { emoji: '❤️', author: { kind: 'agent', ...f.second } },
    ]);
    expect((await listReactionContext(db, f.userId, f.conversationId))[0].reactionEntries).toEqual(
      ownRemoved?.reactionEntries,
    );
  });

  it('retries return the current complete snapshot and cannot alias a different operation', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => f.react('same')));
    await f.react('peer', true, '👍', 'person', f.second);
    expect(await f.react('same')).toMatchObject({ changed: false, revision: 2, reactions: [] });
    expect((await f.react('same'))?.reactionEntries).toHaveLength(2);
    await expect(f.react('same', false)).rejects.toBeInstanceOf(ReactionMutationConflict);
    await f.react('remove', false);
    expect((await f.react('same'))?.reactionEntries).toEqual([
      { emoji: '👍', author: { kind: 'agent', ...f.second } },
    ]);
    const receipts = await db
      .select()
      .from(reactionEvents)
      .where(eq(reactionEvents.oxyUserId, f.userId));
    expect(receipts).toHaveLength(3);
    expect(
      receipts.every((r) => r.status === 'completed' && !r.responseEligible && r.reactorAgentId),
    ).toBe(true);
    expect((await claimReactionEvents(db, { limit: 100 })).some((e) => e.userId === f.userId)).toBe(
      false,
    );
  });

  it('binds membership and target scope, permits direct user and group peer messages, rejects self and strangers', async () => {
    const f = await fixture();
    expect((await f.react('peer', true, '👍', 'peer'))?.changed).toBe(true);
    // ADR0034 rooms have an owning gemie, but that row is not an implicit speaker.
    expect(
      await f.react('room-owner', true, '❤️', 'person', { id: ROOM_GEMIE_ID, name: 'Owner' }),
    ).toBeUndefined();
    expect(await f.react('self', true, '👍', 'peer', f.second)).toBeUndefined();
    expect(
      await mutateAgentMessageReaction(db, 'stranger', f.conversationId, 'person', {
        actor: f.first,
        turnId: 'turn',
        trigger: { kind: 'person', message: { id: 'person', content: 'Gracias' } },
        expectedTarget: { content: 'Gracias', role: 'user', actorId: null },
        mutationId: 'x',
        emoji: '❤️',
        active: true,
      }),
    ).toBeUndefined();
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, f.conversationId),
          eq(conversationMembers.agentId, f.first.id),
        ),
      );
    expect(await f.react('removed')).toBeUndefined();
    const direct = await fixture(true);
    await db
      .update(agents)
      .set({ reach: 'person', memoryStore: 'nilo', taskAuthority: 'standing', mailbox: false })
      .where(eq(agents.id, direct.first.id));
    // A standing-authority gemie participates in its own direct chat through the same capability.
    expect((await direct.react('direct'))?.changed).toBe(true);
    expect((await direct.react('direct-peer', true, '👍', 'peer'))?.changed).toBe(true);
    expect(await direct.react('outsider', true, '❤️', 'person', direct.second)).toBeUndefined();
  });

  it('allows an owned historical peer target after its author leaves without waking it', async () => {
    const f = await fixture();
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, f.conversationId),
          eq(conversationMembers.agentId, f.second.id),
        ),
      );
    expect(await f.react('removed-peer', true, '👍', 'peer')).toMatchObject({ changed: true });
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toEqual([
      expect.objectContaining({
        reactorAgentId: f.first.id,
        targetActorId: f.second.id,
        status: 'completed',
        responseEligible: false,
      }),
    ]);
    await db.delete(agents).where(eq(agents.id, f.second.id));
    expect(await f.react('deleted-peer', true, '🎉', 'peer')).toMatchObject({ changed: true });
    expect((await f.react('still-user'))?.changed).toBe(true);
  });

  it('preserves author state through concurrent client rewrites and legacy human updates, clearing explicit replacement', async () => {
    const f = await fixture();
    await Promise.all([
      f.react('add'),
      replaceMessages(db, f.userId, f.conversationId, [
        {
          clientMessageId: 'person',
          role: 'user',
          content: 'Gracias',
          ...{
            reactionEntries: [
              { emoji: '🔥', author: { kind: 'agent', id: 'spoof', name: 'Spoof' } },
            ],
          },
        },
      ]),
    ]);
    let [row] = await listMessages(db, f.userId, f.conversationId);
    expect(row.reactionEntries).toEqual([{ emoji: '❤️', author: { kind: 'agent', ...f.first } }]);
    await db
      .update(messages)
      .set({ reactions: ['👍'] })
      .where(eq(messages.id, row.id));
    [row] = await listMessages(db, f.userId, f.conversationId);
    expect(row.reactionEntries).toHaveLength(2);
    expect(row.reactionRevision).toBe(2);
    await db.delete(messages).where(eq(messages.id, row.id));
    await db.insert(messages).values({
      oxyUserId: f.userId,
      conversationId: f.conversationId,
      clientMessageId: 'person',
      role: 'user',
      content: 'Legacy echo',
      seq: 0,
    });
    expect((await listMessages(db, f.userId, f.conversationId))[0].reactionEntries).toHaveLength(2);
    await replaceMessages(db, f.userId, f.conversationId, [
      {
        clientMessageId: 'person',
        role: 'assistant',
        content: 'Replacement',
        agentInfo: { ...f.second, handle: '', color: null, character: null },
      },
    ]);
    expect((await listMessages(db, f.userId, f.conversationId))[0].reactionEntries).toEqual([]);
  });

  it('limits each author independently and preserves no-op receipt identity', async () => {
    const f = await fixture();
    for (const emoji of ['❤️', '👍', '🎉', '🔥', '😂', '👀']) await f.react(emoji, true, emoji);
    expect(await f.react('cap', true, '💡')).toMatchObject({ changed: false, revision: 6 });
    expect((await f.react('other', true, '💡', 'person', f.second))?.changed).toBe(true);
    await f.react('remove', false, '❤️');
    expect((await f.react('cap', true, '💡'))?.changed).toBe(false);
  });

  it('requires explicit clean-finish completion backed by same actor/thread/turn receipts and cascades on deletion', async () => {
    const f = await fixture();
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
        { kind: 'person', message: { id: 'person', content: 'Gracias' } },
      ),
    ).toBe(false);
    await f.react('done');
    expect(
      await findAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toBeNull();
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.second.id,
        'admitted-turn',
        { kind: 'person', message: { id: 'person', content: 'Gracias' } },
      ),
    ).toBe(false);
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'different-content-turn',
        { kind: 'person', message: { id: 'person', content: 'Gracias' } },
      ),
    ).toBe(false);
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          markAgentReactionTurnComplete(
            db,
            f.userId,
            f.conversationId,
            f.first.id,
            'admitted-turn',
            { kind: 'person', message: { id: 'person', content: 'Gracias' } },
          ),
        ),
      ),
    ).toEqual([true, true, true, true]);
    expect(
      await findAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toBeTruthy();
    expect(
      await db.select().from(agentReactionTurns).where(eq(agentReactionTurns.oxyUserId, f.userId)),
    ).toHaveLength(1);
    await deleteConversation(db, f.userId, f.conversationId);
    expect(
      await findAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toBeNull();
    expect(
      await db
        .select()
        .from(messageReactionStates)
        .where(eq(messageReactionStates.oxyUserId, f.userId)),
    ).toEqual([]);
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toEqual([]);
  });
});

it('keeps canonical direct retry completion distinct from edits reusing the same user message ID', async () => {
  const f = await fixture(true);
  const snapshot = { id: 'person', content: 'Gracias' };
  const admitted = 'direct:canonical-turn-control';
  const first = agentReactionTurnId(admitted, snapshot);
  const retry = agentReactionTurnId(admitted, { ...snapshot });
  expect(retry).toBe(first);
  await f.react('first-operation', true, '❤️', 'person', f.first, first);
  expect(
    await markAgentReactionTurnComplete(db, f.userId, f.conversationId, f.first.id, first, {
      kind: 'person',
      message: snapshot,
    }),
  ).toBe(true);
  expect(
    await findAgentReactionTurnComplete(db, f.userId, f.conversationId, f.first.id, retry),
  ).not.toBeNull();
  const changed = agentReactionTurnId(admitted, { ...snapshot, content: 'A different request' });
  expect(changed).not.toBe(first);
  expect(
    await findAgentReactionTurnComplete(db, f.userId, f.conversationId, f.first.id, changed),
  ).toBeNull();
  expect(
    await findAgentReactionTurnComplete(db, 'other-person', f.conversationId, f.first.id, retry),
  ).toBeNull();
});

async function peerFixture(reply = false) {
  const f = await fixture();
  const chainId = randomUUID();
  const id = reply ? `group-reply-gemies-${chainId}-1` : `gemie-message-${chainId}-0`;
  const sorted = [f.first.id, f.second.id].sort();
  await db.insert(gemieConversations).values({
    oxyUserId: f.userId,
    conversationId: f.conversationId,
    firstAgentId: sorted[0]!,
    secondAgentId: sorted[1]!,
  });
  await db
    .update(messages)
    .set({ clientMessageId: id })
    .where(and(eq(messages.oxyUserId, f.userId), eq(messages.clientMessageId, 'peer')));
  const trigger: AgentReactionTrigger = {
    kind: 'peer',
    chainId,
    message: { id, content: 'Listo', actorId: f.second.id },
  };
  const react = (admission: AgentReactionTrigger = trigger, mutationId = 'peer-op') =>
    mutateAgentMessageReaction(db, f.userId, f.conversationId, id, {
      actor: f.first,
      turnId: 'peer-turn',
      trigger: admission,
      expectedTarget: { content: 'Listo', role: 'assistant', actorId: f.second.id },
      mutationId,
      emoji: '❤️',
      active: true,
    });
  const complete = () =>
    markAgentReactionTurnComplete(db, f.userId, f.conversationId, f.first.id, 'peer-turn', trigger);
  return { ...f, id, trigger, react, complete };
}

describe('peer-message reaction admission', () => {
  it.each([false, true])(
    'persists and replays a peer contribution without a person trigger or a new wake (reply=%s)',
    async (reply) => {
      const f = await peerFixture(reply);
      expect(await f.complete()).toBe(false);
      const stored = await f.react();
      expect(stored).toMatchObject({
        reactionEntries: [{ emoji: '❤️', author: { kind: 'agent', ...f.first } }],
      });
      expect(await f.react()).toMatchObject({ revision: stored!.revision });
      expect(await f.complete()).toBe(true);
      expect(await f.complete()).toBe(true);
      expect(await countAgentReactionTurnsSince(db, f.userId, f.conversationId, new Date(0))).toBe(
        1,
      );
      expect(
        await listAgentReactionTurnSnapshots(
          db,
          f.userId,
          f.conversationId,
          f.first.id,
          'peer-turn',
        ),
      ).toHaveLength(1);
      const events = await db
        .select()
        .from(reactionEvents)
        .where(eq(reactionEvents.oxyUserId, f.userId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ responseEligible: false, status: 'completed' });
    },
  );

  it('rejects fabricated person admission, wrong peer, chain and owner without feedback writes', async () => {
    const f = await peerFixture();
    expect(await f.react({ kind: 'person', message: null })).toBeUndefined();
    expect(
      await f.react({ kind: 'person', message: { id: 'person', content: 'Gracias' } }),
    ).toBeUndefined();
    expect(
      await markAgentReactionTurnComplete(
        db,
        randomUUID(),
        f.conversationId,
        f.first.id,
        'peer-turn',
        f.trigger,
      ),
    ).toBe(false);
    const trigger = f.trigger;
    if (trigger.kind !== 'peer') throw new Error('Peer fixture required');
    expect(await f.react({ ...trigger, chainId: 'different-chain' })).toBeUndefined();
    expect(
      await f.react({ ...trigger, message: { ...trigger.message, actorId: f.first.id } }),
    ).toBeUndefined();
    expect(
      await f.react({ ...trigger, message: { ...trigger.message, content: 'Edited' } }),
    ).toBeUndefined();
    await db.delete(gemieConversations).where(eq(gemieConversations.oxyUserId, f.userId));
    expect(await f.react()).toBeUndefined();
    expect(await f.complete()).toBe(false);
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toEqual([]);
  });

  it('rejects a hosted actor that becomes local before the locked mutation or completion', async () => {
    const f = await peerFixture();
    await f.react();
    await db
      .update(agents)
      .set({
        identity: 'local',
        oxyAccountId: null,
        localName: 'Local peer',
        localColor: '#123456',
        isPublished: false,
        access: 'private',
        mailbox: false,
        reach: 'grants',
        ownerOxyAccountId: f.userId,
      })
      .where(eq(agents.id, f.first.id));
    expect(await f.react(f.trigger, 'after-local')).toBeUndefined();
    expect(await f.complete()).toBe(false);
    expect(await countAgentReactionTurnsSince(db, f.userId, f.conversationId, new Date(0))).toBe(0);
  });

  it.each(['mutation', 'completion'] as const)(
    'serializes a newer peer message before stale %s',
    async (operation) => {
      const f = await peerFixture();
      if (operation === 'completion') await f.react();
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = db.transaction(async (tx) => {
        await lockMessageThread(tx, f.userId, f.conversationId);
        locked();
        await gate;
        await insertMessages(tx, [
          {
            oxyUserId: f.userId,
            conversationId: f.conversationId,
            clientMessageId: `gemie-message-${randomUUID()}-0`,
            role: 'assistant',
            content: 'Nueva petición',
            seq: 2,
            agentInfo: { ...f.second, handle: '', color: null, character: null },
          },
        ]);
      });
      await ready;
      const stale = operation === 'mutation' ? f.react() : f.complete();
      release();
      await writer;
      expect(await stale).toBe(operation === 'mutation' ? undefined : false);
      expect(
        await findAgentReactionTurnComplete(
          db,
          f.userId,
          f.conversationId,
          f.first.id,
          'peer-turn',
        ),
      ).toBeNull();
    },
  );
});

it('only exposes clean reaction contributions for exact request-derived turn ids and scope', async () => {
  const f = await fixture();
  const trigger = { kind: 'person' as const, message: { id: 'person', content: 'Gracias' } };
  const previous = agentReactionTurnId('previous', trigger.message);
  const current = agentReactionTurnId('current', trigger.message);
  await f.react('previous-reaction', true, '❤️', 'peer', f.first, previous);
  await markAgentReactionTurnComplete(
    db,
    f.userId,
    f.conversationId,
    f.first.id,
    previous,
    trigger,
  );
  expect(await listAgentReactionContributions(db, f.userId, f.conversationId, [current])).toEqual(
    [],
  );
  await f.react('current-reaction', true, '👍', 'peer', f.first, current);
  // A mutation alone cannot be treated as a finished contribution.
  expect(await listAgentReactionContributions(db, f.userId, f.conversationId, [current])).toEqual(
    [],
  );
  await markAgentReactionTurnComplete(db, f.userId, f.conversationId, f.first.id, current, trigger);
  const expected = [
    {
      id: current,
      actorId: f.first.id,
      mutations: [{ messageId: 'peer', emoji: '👍', active: true }],
    },
  ];
  expect(await listAgentReactionContributions(db, f.userId, f.conversationId, [current])).toEqual(
    expected,
  );
  expect(
    await listAgentReactionContributions(db, randomUUID(), f.conversationId, [current]),
  ).toEqual([]);
  expect(await listAgentReactionContributions(db, f.userId, randomUUID(), [current])).toEqual([]);
  const edited = agentReactionTurnId('current', { ...trigger.message, content: 'Changed' });
  expect(await listAgentReactionContributions(db, f.userId, f.conversationId, [edited])).toEqual(
    [],
  );
});
