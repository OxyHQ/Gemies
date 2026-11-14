/**
 * An external agent's tools come from the one assembler (ADR 0039), on a lane that acts for its
 * owner with no Oxy session and no credit reservation, for a gemie with no Oxy account (ADR 0036):
 * its granted connectors reach it; the person's Oxy apps, hosted inference behind a tool, and a
 * memory of Gemies' (whose journal needs an account) do not — and none of that throws. It writes to
 * other gemies (ADR 0041) when its run names the person's chat with it.
 */
import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { personaGemie } from '../../../__tests__/support/gemies.js';

const seen = vi.hoisted(() => ({ mcpSelection: [] as unknown[], oxyCalls: 0 }));
const tool = { description: 'x', execute: async () => ({}) } as unknown as ToolSet[string];

vi.mock('../../tools/mcp.js', () => ({
  buildMcpTools: vi.fn(async (_userId: string, selection: unknown) => {
    seen.mcpSelection.push(selection);
    return { mcp_notion__search: tool } as ToolSet;
  }),
}));
vi.mock('../../tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async () => {
    seen.oxyCalls += 1;
    return { oxy_inbox__searchEmails: tool } as ToolSet;
  }),
  getOxyServicePromptFragment: vi.fn(() => ''),
  getOxyServiceContext: vi.fn(async () => ''),
}));
vi.mock('../../tools/send-message.js', () => ({
  buildSendMessageTool: vi.fn(async () => ({ sendMessage: tool })),
}));
vi.mock('../../agent/agent-memory-runtime.js', () => ({
  buildAgentMemoryTool: vi.fn(() => tool),
  agentMemoryPromptSection: vi.fn(async () => ''),
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, tools: child } };
});
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));

const { ToolPipeline } = await import('../../tool-pipeline.js');

/** An external agent: a `local` gemie of `person-1`, granted the web, memory, an account and agents. */
const externalGemie = () =>
  personaGemie({
    identity: { source: 'local', name: 'Claude Code · desk', color: 'orange' },
    ownerOxyAccountId: 'person-1',
    mailbox: false,
    memoryStore: 'gemie',
    capabilityGrants: ['web', 'memory', 'artifacts', 'mcp:notion-1', 'agent'],
  });

beforeEach(() => {
  seen.mcpSelection.length = 0;
  seen.oxyCalls = 0;
});

const lane = (over: Partial<Parameters<typeof ToolPipeline.forUser>[0]> = {}) =>
  ToolPipeline.forUser({
    userId: 'person-1',
    requesterAccountId: 'person-1',
    isDirectSession: false,
    actsForPerson: true,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: true,
    agent: externalGemie(),
    ...over,
  });

describe('the external agent’s tool lane', () => {
  it('writes to other gemies only from the person’s chat with it', async () => {
    expect(Object.keys((await lane()).tools)).not.toContain('sendMessage');
    expect(Object.keys((await lane({ gemieChat: 'chat-1' })).tools)).toContain('sendMessage');
  });

  it('builds what it was granted and needs no account, and nothing else', async () => {
    const { tools } = await ToolPipeline.forUser({
      userId: 'person-1',
      requesterAccountId: 'person-1',
      isDirectSession: false,
      actsForPerson: true,
      toolsEnabled: true,
      webSearch: true,
      isLocalRuntime: true,
      agent: externalGemie(),
    });
    const names = Object.keys(tools);

    expect(names).toEqual(
      expect.arrayContaining(['getCurrentDate', 'webSearch', 'generateFile', 'mcp_notion__search']),
    );
    expect(seen.mcpSelection).toHaveLength(1);
    // No Oxy authority on this lane: the person's apps are not even fetched.
    expect(seen.oxyCalls).toBe(0);
    expect(names).not.toContain('oxy_inbox__searchEmails');
    // No account, so no memory of Gemies' (and no throw from asking for one).
    expect(names).not.toContain('memory');
    expect(names).not.toContain('searchThread');
    // Unreserved: nothing that runs hosted inference behind a tool call.
    expect(names).not.toContain('deepResearch');
    // And no conversation named, so no writing to other gemies either.
    expect(names).not.toContain('sendMessage');
    // No session: nothing that needs the person's own bearer.
    expect(names).not.toContain('createAutomation');
    expect(names).not.toContain('createAgent');
  });
});
