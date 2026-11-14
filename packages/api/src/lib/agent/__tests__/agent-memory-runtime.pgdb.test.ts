import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolCallOptions } from 'ai';
import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import {
  deleteAgentMemory,
  readAgentMemory,
  writeAgentMemory,
} from '../../../db/agents/agentMemoryRepository.js';
import { agentMemoryPromptSection, buildAgentMemoryTool } from '../agent-memory-runtime.js';
import { hashAgentMemory } from '../memory-contract.js';

/**
 * The agent's own memory of a person, used by the agent, against a REAL
 * server: what it saves is what the next conversation's prompt carries, and a
 * write that races the person's own edit is refused rather than lost.
 */

const USER = `agent-memory-${Math.random().toString(36).slice(2, 10)}`;
const AGENT = `agent-${Math.random().toString(36).slice(2, 10)}`;
const OPTIONS = { toolCallId: 't', messages: [] } as unknown as ToolCallOptions;

beforeAll(() => {
  if (!connectPostgres(process.env.DATABASE_URL))
    throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
});

afterAll(async () => {
  await closePostgres();
});

describe("an agent's memory of one person", () => {
  const memory = buildAgentMemoryTool({
    oxyUserId: USER,
    agentId: AGENT,
    actorOxyAccountId: AGENT,
  });
  const call = (input: Record<string, unknown>) => memory.execute!(input as never, OPTIONS);

  it('starts empty, and says so in the prompt', async () => {
    expect(await agentMemoryPromptSection(USER, AGENT)).toContain('is empty');
  });

  it('appends lines that the next prompt carries', async () => {
    expect(await call({ action: 'append', content: 'Prefers answers in Spanish' })).toBe(
      'Saved MEMORY.md.',
    );
    expect(await call({ action: 'append', content: 'Is training for a marathon in March' })).toBe(
      'Saved MEMORY.md.',
    );

    const section = await agentMemoryPromptSection(USER, AGENT);
    expect(section).toContain('Prefers answers in Spanish\nIs training for a marathon in March');
    expect(await call({ action: 'read' })).toBe(
      'Prefers answers in Spanish\nIs training for a marathon in March\n',
    );
  });

  it('keeps topic files beside the index and lists them', async () => {
    await call({ action: 'replace', path: 'memory/training.md', content: '# Plan\n4 runs a week' });
    expect(await call({ action: 'list' })).toContain('memory/training.md');
    expect(await call({ action: 'read', path: 'memory/training.md' })).toBe(
      '# Plan\n4 runs a week',
    );
  });

  it('refuses a path outside its memory', async () => {
    expect(String(await call({ action: 'read', path: '../secrets.md' }))).toMatch(/^Error:/);
  });

  it('builds on an edit the person made in between, never over it', async () => {
    // The person edits the file between the agent's read and its write: the
    // repository compares the hash the tool read with the stored one.
    const before = await readAgentMemory(
      await import('../../../db/index.js').then((m) => m.getDb()),
      USER,
      AGENT,
      'MEMORY.md',
    );
    await writeAgentMemory((await import('../../../db/index.js')).getDb(), {
      oxyUserId: USER,
      agentId: AGENT,
      actorOxyAccountId: USER,
      path: 'MEMORY.md',
      content: 'Edited by the person\n',
      expectedHash: before?.contentHash ?? hashAgentMemory(''),
      origin: 'person',
    });
    expect(await call({ action: 'append', content: 'Another fact' })).toBe('Saved MEMORY.md.');
    expect(await call({ action: 'read' })).toBe('Edited by the person\nAnother fact\n');
  });
});

describe('a memory the person forgot while a turn ran', () => {
  const person = `agent-memory-forget-${Math.random().toString(36).slice(2, 10)}`;
  const remember = (content: string) =>
    writeAgentMemory(getDb(), {
      oxyUserId: person,
      agentId: AGENT,
      actorOxyAccountId: person,
      path: 'MEMORY.md',
      content,
      expectedHash: hashAgentMemory(''),
      origin: 'person',
    });
  const turn = () => {
    const memory = buildAgentMemoryTool({
      oxyUserId: person,
      agentId: AGENT,
      actorOxyAccountId: AGENT,
    });
    return (input: Record<string, unknown>) => memory.execute!(input as never, OPTIONS);
  };

  it('is never put back by that turn, from the copy it still holds', async () => {
    await remember('Their doctor is Dr. Ruiz\n');
    const call = turn();
    await call({ action: 'list' });
    // The person forgets it in the app; the turn's prompt still carries the old text.
    await deleteAgentMemory(getDb(), { oxyUserId: person, agentId: AGENT });

    expect(
      String(await call({ action: 'replace', content: 'Their doctor is Dr. Ruiz\nLikes tea\n' })),
    ).toMatch(/^Error: the person removed part of your memory/);
    expect(await readAgentMemory(getDb(), person, AGENT, 'MEMORY.md')).toBeUndefined();

    // The next turn starts from what is kept now, and may save again.
    expect(await turn()({ action: 'append', content: 'Likes tea' })).toBe('Saved MEMORY.md.');
  });

  it('is not what the agent forgot itself: it goes on saving in that turn', async () => {
    const call = turn();
    await call({ action: 'list' });
    expect(await call({ action: 'forget' })).toBe('Forgot MEMORY.md.');
    expect(await call({ action: 'append', content: 'Prefers mornings' })).toBe('Saved MEMORY.md.');
  });
});
