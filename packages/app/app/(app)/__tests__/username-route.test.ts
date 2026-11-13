import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `/@username` is two pages, told apart by the account: an agent's thread and a person's profile.
 * These read the source, so they pin the decision without rendering the thread's whole tree.
 */
const source = readFileSync(
  fileURLToPath(new URL('../(own-header)/[username]/index.tsx', import.meta.url)),
  'utf8',
);
/** The thread itself, the same screen `/agents/<id>` opens for a gemie with no handle. */
const screen = readFileSync(
  fileURLToPath(
    new URL('../../../src/features/agents/ui/agent-thread-screen.tsx', import.meta.url),
  ),
  'utf8',
);

describe('/@username', () => {
  it('looks the account up beside the thread, so an agent waits for nothing', () => {
    expect(source).toContain('useAgentThread(thread, threadId)');
    expect(source).toContain('usePersonProfile(');
  });

  it('opens a person as a profile only when the thread is not there, and never for a thread by id', () => {
    expect(source).toMatch(/data === undefined && person !== undefined/);
    // A thread asked for by id is an agent's: no account lookup for it.
    expect(source).toMatch(/threadId === undefined \? handle : ''/);
  });

  it('keeps one 404 for a username that is neither: it reveals nothing about an agent', () => {
    expect(source).toContain('resolving={profilePending}');
    expect(screen).toMatch(/isError && !resolving/);
    expect(screen).toContain("t('agents.notFound')");
  });
});
