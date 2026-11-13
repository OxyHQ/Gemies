/**
 * A standing task outlives the sessions that borrow it (ADR 0037, amendment): a channel turn of a
 * gemie bot's person runs its session under the task they granted the bot, and ending that session
 * must never revoke it — only removing the link or the bot does. A session's own task is still
 * retired as before.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TEST_CHARACTER } from '../../db/__tests__/support/agent-character';

const revoked = vi.hoisted(() => [] as string[]);
vi.mock('../oxy.js', () => ({
  oxy: {
    agency: {
      revokeTask: vi.fn(async (taskId: string) => {
        revoked.push(taskId);
      }),
    },
  },
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index';
import { createAgent } from '../../db/agents/agentRepository';
import { createAgentSession } from '../../db/agents/agentSessionRepository';
import { saveGemieBot, setGemieBotLinkCode } from '../../db/integrations/gemieBotRepository';
import { retireFinishedOxyTasks, revokeSessionTask } from '../oxy-task-authority';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('No test DB');
  db = connected;
});
afterAll(() => closePostgres());

it('never retires the task a gemie bot’s person granted, only a session’s own', async () => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'cd'.repeat(32));
  const owner = randomUUID();
  const agent = await createAgent(db, {
    character: TEST_CHARACTER,
    identity: { source: 'oxy', oxyAccountId: randomUUID() },
    ownerOxyAccountId: owner,
    authorOxyUserId: owner,
    tagline: 'test',
    description: 'test',
    category: 'research',
    access: 'private',
  });
  const botId = String(7_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  await saveGemieBot(db, {
    agentId: agent.id,
    userId: owner,
    botId,
    name: 'Eusebio',
    username: 'EusebioOxyBot',
    botToken: `${botId}:TOKEN`,
    ownerPaysAgentTurns: true,
  });
  const botTask = randomUUID();
  await setGemieBotLinkCode(db, {
    agentId: agent.id,
    userId: owner,
    codeHash: 'h',
    expiresAt: new Date(Date.now() + 60_000),
    oxyTaskId: botTask,
  });
  const ownTask = randomUUID();
  for (const oxyTaskId of [botTask, ownTask]) {
    await createAgentSession(db, {
      agentId: agent.id,
      oxyUserId: owner,
      oxyTaskId,
      task: 'done',
      status: 'completed',
    });
  }

  await retireFinishedOxyTasks();
  expect(revoked).toContain(ownTask);
  expect(revoked).not.toContain(botTask);

  // Cancelling a session that borrowed it leaves it standing too.
  await revokeSessionTask(botTask);
  expect(revoked).not.toContain(botTask);
  vi.unstubAllEnvs();
});
