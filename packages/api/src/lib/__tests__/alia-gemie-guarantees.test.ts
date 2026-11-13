/**
 * Alia is a gemie (ADR 0034 §2), and the guarantees that held while she was "the turn with no agent"
 * keep holding now that she is a row whose configuration says what she may do:
 *
 *  - her memory (Nilo's, `memoryStore = 'nilo'`) never reaches another gemie, in tools or prompt;
 *  - consulting a gemie stays one level deep, whoever is consulted;
 *  - a chat with her runs as it did: Oxy's person lane, no `self_*` account (no mailbox), no
 *    machine, the person's installed skills, the base identity and no remit;
 *  - the public wire still spells her as no `agentId`;
 *  - her thread with a person is apart from her loose chats, and a turn in it is still hers.
 *
 * The real assembler and prompt builder run here; only the bulk sources are stubbed, and the Oxy
 * source answers with BOTH Alia's memory tools and an own-account tool whatever it is asked, so the
 * filter that keeps them out is the code under test, not the stub.
 */
import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aliaGemie, personaGemie } from '../../__tests__/support/gemies.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOfFile } from '../../__tests__/support/source-code.js';
import { ALIA_GEMIE_ID, ROOM_GEMIE_ID, publicAgentId } from '../../domain/alia-gemie.js';

const seen = vi.hoisted(() => ({
  oxy: [] as Array<{ actor?: unknown; agentIdentity?: unknown; requesterAccountId?: string }>,
  skillsIncluded: [] as boolean[],
}));

vi.mock('../tools/mcp.js', () => ({ buildMcpTools: vi.fn(async () => ({})) }));
vi.mock('../tools/integrations.js', () => ({ buildIntegrationTools: vi.fn(async () => ({})) }));
vi.mock('../tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async (_userId: string, context: (typeof seen.oxy)[number]) => {
    seen.oxy.push(context);
    const tool = { description: 'x', execute: async () => ({}) } as unknown as ToolSet[string];
    return {
      oxy_nilo_memories__recallMemories: tool,
      oxy_nilo_memories__remember: tool,
      oxy_inbox__searchEmails: tool,
    } as ToolSet;
  }),
  getOxyServicePromptFragment: vi.fn(() => ''),
  getOxyServiceContext: vi.fn(async () => '\n\nINBOX CONTEXT OF THE PERSON'),
}));
vi.mock('../tools/consult-agent.js', () => ({
  buildConsultAgentTool: vi.fn(async () => ({ consultAgent: { description: 'consult' } })),
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child },
  };
});
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../agent/agent-memory-runtime.js', () => ({
  buildAgentMemoryTool: vi.fn(() => ({ description: 'own memory' })),
  agentMemoryPromptSection: vi.fn(async () => '\n\nTHE GEMIE OWN MEMORY'),
}));

const { ToolPipeline } = await import('../tool-pipeline.js');
const { createAgentReactionTurn } = await import('../chat/reactions/agent-tool.js');
const { SystemPromptBuilder } = await import('../system-prompt-builder.js');
const { threadIsThePair } = await import('../gemie-thread.js');

const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const NILO = ['oxy_nilo_memories__recallMemories', 'oxy_nilo_memories__remember'];

async function toolsFor(
  agent: ReturnType<typeof aliaGemie>,
  over: Partial<Parameters<typeof ToolPipeline.forUser>[0]> = {},
): Promise<string[]> {
  const { tools } = await ToolPipeline.forUser({
    userId: 'person-1',
    accessToken: 'token-1',
    isDirectSession: true,
    actsForPerson: true,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: false,
    agent,
    skills: {
      index: '',
      active: '',
      tools: { loadSkill: { description: 'skill' } as ToolSet[string] },
      agentScoped: false,
      candidateIds: [],
      activated: () => [],
    },
    ...over,
  });
  return Object.keys(tools);
}

/** A persona the person owns, granted everything Alia is granted, memory included. */
const persona = () =>
  personaGemie({
    ownerOxyAccountId: 'person-1',
    capabilityGrants: [...aliaGemie().capabilityGrants],
  });

beforeEach(() => {
  seen.oxy.length = 0;
  vi.clearAllMocks();
});

describe('Alia’s memory never reaches another gemie', () => {
  it('reaches Alia: Nilo’s tools, and none of a gemie’s own memory tools', async () => {
    const names = await toolsFor(aliaGemie());
    for (const tool of NILO) expect(names).toContain(tool);
    expect(names).not.toContain('memory');
    expect(names).not.toContain('searchThread');
  });

  it('never reaches a persona, even granted memory and even when the catalogue offers it', async () => {
    const names = await toolsFor(persona());
    for (const tool of NILO) expect(names).not.toContain(tool);
    // Its own memory is there instead, and the person's other apps are untouched.
    expect(names).toContain('memory');
    expect(names).toContain('oxy_inbox__searchEmails');
  });

  it('never reaches a gemie configured with the person’s reach but its own memory store', async () => {
    const names = await toolsFor({ ...aliaGemie(), _id: 'x', id: 'x', memoryStore: 'gemie' });
    for (const tool of NILO) expect(names).not.toContain(tool);
  });

  it('stays out of a persona’s prompt: no memory prompt, no answer settings, no writing style', async () => {
    const userMemory = {
      preferences: { tone: 'warm', responseLength: 'short' },
      settings: { recallEnabled: true },
      writingStyle: null,
    } as unknown as Parameters<typeof SystemPromptBuilder.build>[0]['userMemory'];
    const prompt = await SystemPromptBuilder.build({
      surface: 'chat',
      isDirectUserSession: true,
      userId: 'person-1',
      accessToken: 'token-1',
      userMemory,
      linkedAgent: persona(),
      toolNames: NILO,
    });
    expect(prompt).not.toContain('Answer preferences the person set');
    expect(prompt).toContain('THE GEMIE OWN MEMORY');

    const aliaPrompt = await SystemPromptBuilder.build({
      surface: 'chat',
      isDirectUserSession: true,
      userId: 'person-1',
      accessToken: 'token-1',
      userMemory,
      linkedAgent: aliaGemie(),
      toolNames: NILO,
    });
    expect(aliaPrompt).toContain('Answer preferences the person set');
    expect(aliaPrompt).not.toContain('THE GEMIE OWN MEMORY');
  });
});

describe('consulting stays one level deep', () => {
  it.each([
    ['Alia', aliaGemie],
    ['a persona', persona],
  ])('a nested turn of %s holds no consultAgent and no catalogue search', async (_, gemie) => {
    const names = await toolsFor(gemie(), { nested: true });
    expect(names).not.toContain('consultAgent');
    expect(names).not.toContain('searchAgents');
    expect(names).not.toContain('createAgent');
  });

  it('the outer turn of either still consults (the control)', async () => {
    expect(await toolsFor(aliaGemie())).toContain('consultAgent');
    expect(await toolsFor(persona())).toContain('consultAgent');
  });
});

describe('a chat with Alia runs as it did', () => {
  it('speaks Oxy’s person lane for the person present, with no own account', async () => {
    await toolsFor(aliaGemie());
    expect(seen.oxy.at(-1)).toMatchObject({
      requesterAccountId: 'person-1',
      actor: { type: 'alia', ownerAccountId: 'person-1' },
    });
    // No agent identity at all: no `self_*` set is even considered (no mailbox).
    expect(seen.oxy.at(-1)?.agentIdentity).toBeUndefined();
  });

  it('a persona speaks as its own account, and only its mailbox opens its own account', async () => {
    await toolsFor(persona());
    expect(seen.oxy.at(-1)).toMatchObject({
      actor: { type: 'agent', accountId: 'bot-account-1' },
      agentIdentity: { forUser: 'owner', self: true },
    });
    await toolsFor({ ...persona(), mailbox: false });
    expect(seen.oxy.at(-1)).toMatchObject({ agentIdentity: { forUser: 'owner', self: false } });
  });

  it('offers the person’s installed skills to Alia, and not to a persona whose skills are not linked', async () => {
    expect(await toolsFor(aliaGemie())).toContain('loadSkill');
    expect(await toolsFor(persona())).not.toContain('loadSkill');
  });

  it('builds her no machine, whatever the surface', async () => {
    const names = await toolsFor(aliaGemie());
    for (const tool of ['browser', 'computer_start', 'run_computer_command']) {
      expect(names).not.toContain(tool);
    }
  });

  it('keeps her identity and the person’s context in the prompt, with no remit', async () => {
    const prompt = await SystemPromptBuilder.build({
      surface: 'chat',
      isDirectUserSession: true,
      userId: 'person-1',
      accessToken: 'token-1',
      oxyUser: { name: { full: 'Ana' } } as Parameters<
        typeof SystemPromptBuilder.build
      >[0]['oxyUser'],
      linkedAgent: aliaGemie(),
    });
    expect(prompt).toContain('You are Alia, an AI assistant.');
    expect(prompt).toContain("The user's name is Ana.");
    expect(prompt).toContain('INBOX CONTEXT OF THE PERSON');
    expect(prompt).not.toContain('## YOUR REMIT');
    expect(prompt).not.toContain('# AGENT:');
  });
});

describe('the public wire', () => {
  it('spells Alia’s gemie, and so a room’s, as no agentId; any other gemie by its id', () => {
    expect(publicAgentId(ALIA_GEMIE_ID)).toBeNull();
    expect(publicAgentId(ROOM_GEMIE_ID)).toBeNull();
    expect(publicAgentId('gemie-1')).toBe('gemie-1');
  });
});

describe('her thread (ADR 0034: the Alia app’s continuous mode)', () => {
  it('is apart from her loose chats; a persona’s thread is still every conversation of the pair', () => {
    expect(threadIsThePair(aliaGemie())).toBe(false);
    expect(threadIsThePair(persona())).toBe(true);
  });

  it('a turn in it is assembled exactly as any turn of hers: nothing on the turn path reads the stretch', () => {
    /**
     * Which gemie speaks, its memory, reach, tools, prompt and authority come from the request and
     * the gemie's row, never from the conversation's thread. Pinned here so a later "thread mode"
     * branch has to come through this file: the cases above then hold for a turn in her thread too.
     */
    for (const file of [
      'lib/tool-pipeline.ts',
      'lib/system-prompt-builder.ts',
      'lib/chat/turn-inputs.ts',
      'lib/chat/request-context.ts',
      'routes/v1/chat-completions.ts',
    ]) {
      expect(codeOfFile(path.join(API_SRC, file))).not.toMatch(/agentThreadId|agent_thread_id/);
    }
  });
});

describe('native conversation reactions use the configured gemie', () => {
  it.each([aliaGemie(), persona()])(
    'offers the bound local capability without mixing memory for $reach',
    async (agent) => {
      const reaction = createAgentReactionTurn(
        {
          userId: 'person-1',
          conversationId: 'conversation-1',
          turnId: 'admitted-turn',
          actor: { id: agent._id, name: 'Acting gemie' },
          targets: [],
        },
        {
          mutate: async () => undefined,
          publish: async () => undefined,
          complete: async () => true,
        },
      );
      const names = await toolsFor(agent, { conversationReaction: reaction });
      expect(names).toContain('react_to_message');
      for (const name of NILO) expect(names.includes(name)).toBe(agent.memoryStore === 'nilo');
      await expect(
        toolsFor(agent, { userId: 'different-person', conversationReaction: reaction }),
      ).rejects.toThrow('Conversation reaction scope');
    },
  );
});
