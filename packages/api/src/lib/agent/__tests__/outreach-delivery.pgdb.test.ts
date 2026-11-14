import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TEST_CHARACTER } from '../../../db/__tests__/support/agent-character';
vi.mock('../../agent-identity', () => ({
  attachAgentIdentity: async (agent: object) => ({ ...agent, name: 'Scout', handle: 'scout' }),
  agentPromptName: () => 'Scout',
}));
vi.mock('../../notification-service', () => ({ sendNotification: vi.fn(async () => {}) }));
vi.mock('../../../socket', () => ({ getIO: () => null }));
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index';
import { createAgent } from '../../../db/agents/agentRepository';
import { messages } from '../../../db/schema/chat';
import {
  countAgentOutreachSince,
  countOutreachInConversationSince,
  findLastMessage,
  insertMessages,
} from '../../../db/chat/messageRepository';
import { sendNotification } from '../../notification-service';
import { postAgentMessage } from '../agent-outreach';
import { aliaOutreachConversationId, postAliaCheckIn } from '../alia-outreach';
import { CHECK_IN_DAILY_LIMIT } from '../outreach-budget';
let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('No test DB');
  db = connected;
});
afterAll(() => closePostgres());
async function seed() {
  const owner = randomUUID();
  const agent = await createAgent(db, {
    character: TEST_CHARACTER,
    identity: { source: 'oxy', oxyAccountId: randomUUID() },
    ownerOxyAccountId: owner,
    authorOxyUserId: owner,
    tagline: 'test',
    description: 'test',
    category: 'research',
  });
  return { owner, agent };
}
it('concurrent delivery of the same outcome appends and notifies exactly once', async () => {
  const { owner, agent } = await seed();
  const input = {
    oxyUserId: owner,
    agentId: agent.id,
    kind: 'check_in' as const,
    content: 'The work is ready',
    idempotencyKey: randomUUID(),
  };
  const results = await Promise.all([postAgentMessage(input), postAgentMessage(input)]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].posted).toBe(true);
  expect(await db.select().from(messages).where(eq(messages.oxyUserId, owner))).toHaveLength(1);
  expect(
    vi
      .mocked(sendNotification)
      .mock.calls.filter(([notification]) => notification.userId === owner),
  ).toHaveLength(1);
});
it('concurrent check-ins respect the unanswered limit while requested results stay deliverable', async () => {
  const { owner, agent } = await seed();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      postAgentMessage({
        oxyUserId: owner,
        agentId: agent.id,
        kind: 'check_in',
        content: `Update ${n}`,
      }),
    ),
  );
  expect(results.filter((result) => result.posted)).toHaveLength(2);
  expect(await countAgentOutreachSince(db, owner, agent.id, new Date(0))).toBe(2);
  expect(
    (
      await postAgentMessage({
        oxyUserId: owner,
        agentId: agent.id,
        kind: 'result',
        content: 'Requested result',
      })
    ).posted,
  ).toBe(true);
  expect(await countAgentOutreachSince(db, owner, agent.id, new Date(0))).toBe(2);
});
it('concurrent Alia check-ins with one slot of the daily budget left post exactly one', async () => {
  const owner = randomUUID();
  const conversationId = aliaOutreachConversationId(owner);
  const checkIn = (content: string) =>
    postAliaCheckIn({
      oxyUserId: owner,
      content,
      title: 'Important email',
      conversationTitle: 'Alia',
    });
  // Spend all but one slot, each answered so the unanswered rule never applies.
  for (let n = 0; n < CHECK_IN_DAILY_LIMIT - 1; n++) {
    expect((await checkIn(`Email ${n}`)).posted).toBe(true);
    const last = await findLastMessage(db, owner, conversationId);
    await insertMessages(db, [
      {
        conversationId,
        oxyUserId: owner,
        role: 'user',
        content: 'Thanks',
        seq: (last?.seq ?? 0) + 1,
        createdAt: new Date(),
      },
    ]);
  }

  const results = await Promise.all([checkIn('Email A'), checkIn('Email B')]);

  expect(results.filter((result) => result.posted)).toHaveLength(1);
  expect(results.find((result) => !result.posted)).toEqual({
    posted: false,
    reason: 'daily_limit',
  });
  expect(await countOutreachInConversationSince(db, owner, conversationId, new Date(0))).toBe(
    CHECK_IN_DAILY_LIMIT,
  );
});
