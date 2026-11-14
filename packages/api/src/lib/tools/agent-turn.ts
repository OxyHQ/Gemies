import { reserveBackgroundProductCredits } from '../product-credit-access';
/**
 * ONE turn of a gemie that is not the person's live chat with it, streamed and PAID FOR: a member's
 * turn in a group room (ADR 0025), a reaction observation, and both sides of a conversation between
 * gemies (ADR 0041) — the gemie that was written to answering, and the one that wrote continuing
 * once it has the answer.
 *
 * ## It is the gemie's turn FOR THE SAME PERSON
 *
 * The turn is assembled by `ToolPipeline.forUser` as that person's turn with this gemie as the
 * agent, so it reaches exactly what an ordinary conversation with it would — its own families and
 * memory of this person, and the person's Oxy apps on the task the turn runs under (ADR 0022).
 *
 * `nested: true` is the recursion bound and the surface bound at once: a turn here never opens a
 * conversation with another gemie, searches the catalogue, creates agents, or gets host or SSE
 * tools. The one exception is `gemieChain`: the gemie that wrote first in a conversation between
 * gemies, reading the answer, may write once more, to the gemie it talks to and nobody else.
 *
 * ## The person pays
 *
 * `payerOxyUserId` reserves, settles and refunds on its own; every exit either settles or refunds.
 *
 * ## It answers as ITSELF
 *
 * The system message is the identity guard plus the agent's remit — the same composition every
 * agent surface uses — and the caller's protocol (`room.instructions`) after it.
 */

import { streamText, type ToolSet } from 'ai';
import type { ForUserOptions } from '../tool-pipeline.js';
import { stepBudget } from '../tool-budget.js';
import { owedAnswerRequest, owesAnswer } from '../chat/tool-synthesis.js';
import { agentPromptName, type HydratedAgent } from '../agent-identity.js';
import { agentRemitPrompt } from '../agent/archetype-prompts.js';
import { agentSpacePrompt } from '../agent/space-prompt.js';
import { buildIdentityGuard } from '../identity-guard.js';
import { isAliaMemoryTool } from './oxy-tool-names.js';
import { SEND_MESSAGE_TOOL } from './send-message.js';
import { resolveStoredModel, getAIModel } from '../chat-core.js';
import { evolveAgentSoul } from '../agent/soul.js';
import { finalizeCredits, refundReservation, type CreditReservation } from '../credits-manager.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { servedModelId, servedReferenceOf } from '../models/power-levels.js';
import { isExternalAgent, runExternalAgentTurn } from '../external-agents/turn.js';

/** Bounded so one turn never holds a room, or a conversation between gemies, for long. */
const AGENT_TIMEOUT_MS = 45_000;
const AGENT_MAX_STEPS = 8;
const AGENT_MAX_OUTPUT_TOKENS = 4096;

/**
 * What the person's own assistant (`reach = 'person'`, Alia) can use in a turn here, where another
 * gemie wrote to her or she is following up on what one answered: READING tools only. She holds
 * powers a gemie may not (sending messages, writing memory, connectors that act), and a message must
 * not be a way to borrow them, so everything that changes something is left out: the built-ins below
 * only read, and the person's Oxy apps are held to `read_only` autonomy, which Oxy enforces when a
 * tool runs. `loadTools` is the budget's way of loading those apps' tools and is kept with them.
 *
 * Her memory of the person (Nilo) is left out too: it never reaches another gemie (ADR 0034), and in
 * a conversation with one, whatever she reads she could repeat to it.
 */
const ALIA_READING_BUILTIN_TOOLS = new Set([
  // Writing on in a chain she started, to the one gemie she talks to (`gemieChain`).
  SEND_MESSAGE_TOOL,
  'getCurrentDate',
  'getWeather',
  'getMarketQuote',
  'getFairCoin',
  'webSearch',
  'webScraper',
  'loadTools',
]);

/** Alia's tools in a turn here, from the full set. Pure. */
export function aliaReadingTools(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) =>
        ALIA_READING_BUILTIN_TOOLS.has(name) ||
        (name.startsWith('oxy_') && !isAliaMemoryTool(name)),
    ),
  );
}

export interface AgentTurnResult {
  response: string;
  tokensUsed: number;
  /** What the nested turn actually cost the payer, after settlement. */
  creditsCharged: number;
  /** Why there is no response: a turn here fails as a value, never a throw. */
  error?: string;
}

/** The person the nested turn is for, exactly as the outer turn holds them. */
export interface AgentTurnPerson {
  oxyUserId: string;
  /** The person's live bearer, for Oxy direct requests; absent on an unattended turn. */
  accessToken?: string;
  isDirectSession: boolean;
  taskId?: string;
  /** The app the person is in, by its verified app assertion (ADR 0021), or `null`. */
  surfaceApplicationId: string | null;
}

/** One earlier message of the conversation a turn answers. */
export interface AgentTurnMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** What the nested turn shows while it runs. Each callback is best effort. */
export interface AgentTurnObserver {
  onTextDelta?: (text: string) => void;
  onToolCall?: (call: { toolCallId: string; name: string; input: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; name: string; output: unknown }) => void;
}

function failed(error: string): AgentTurnResult {
  return { response: '', tokensUsed: 0, creditsCharged: 0, error };
}

/**
 * Run one streamed turn of `agent` on `task` for `person`, billed to
 * `payerOxyUserId`.
 *
 * @param agent Already resolved and AUTHORISED by the caller (`canReachAgent`).
 */
export async function runAgentTurn(input: {
  /**
   * The gemie whose turn it is. The person's own assistant (`reach = 'person'`, Alia) works
   * read-only, under the base identity ({@link aliaReadingTools}); any other gemie under its remit.
   */
  agent: HydratedAgent;
  task: string;
  person: AgentTurnPerson;
  payerOxyUserId: string;
  observer?: AgentTurnObserver;
  /** What was said before `task`, oldest first: a turn answers a conversation, not a lone question. */
  history?: readonly AgentTurnMessage[];
  /**
   * The chain this turn continues, when it is the gemie that wrote first reading the answer: the
   * assembler builds its `sendMessage`, bound to `peerId` (`lib/chat/gemies/engine.ts`).
   */
  gemieChain?: ForUserOptions['gemieChain'];
  /** Server-owned group protocol and observations since the person's message. */
  room?: { readonly instructions: string; readonly observations: readonly AgentTurnMessage[] };
  /** A server-attributed observation can invite words, never tools or an inferred user task. */
  observation?: { readonly instructions: string; readonly content: string };
  /** A tighter limit than {@link AGENT_TIMEOUT_MS}, for a turn that shares a request's time. */
  timeoutMs?: number;
  /** Caller cancellation (for example, a newer substantive message or retracted feedback). */
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  const { agent, task, person, payerOxyUserId, observer } = input;
  const start = Date.now();
  const personAssistant = agent.reach === 'person';

  // An external agent (ADR 0030) is answered by the person's own daemon: no model, no tools of
  // ours, no credits. This one branch serves group rooms, conversations between gemies and any
  // other caller.
  if (agent.taskAuthority === 'session' && (await isExternalAgent(agent._id))) {
    // The external task protocol has no enforceable tools-disabled mode. Keep feedback in later
    // ordinary context, without giving a daemon an unsolicited task that could execute actions.
    if (input.observation) return failed('This agent cannot receive a tool-free observation turn');
    return runExternalAgentTurn({
      agentId: agent._id,
      task: input.room
        ? `${input.room.instructions}\n\nThe message to answer: ${JSON.stringify(task)}\n\nSubsequent room observations: ${JSON.stringify(input.room.observations)}`
        : task,
      ...(input.history ? { history: input.history } : {}),
      ...(observer?.onTextDelta ? { onTextDelta: observer.onTextDelta } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  // The gemie's remit, then — for a member of a SPACE — the space and its shared notes (ADR 0028). This
  // is the system prompt of every turn here (a group room, a conversation between gemies), so the
  // space reaches the member here and not only in a chat with the person. What the turn is FOR is the
  // caller's protocol (`room.instructions`), after it.
  const systemPrompt = personAssistant
    ? buildIdentityGuard()
    : `${buildIdentityGuard({
        agentName: agentPromptName(agent),
      })}\n\n---\n\n${agentRemitPrompt(agent)}${await agentSpacePrompt(agent)}`;
  const observationMemory =
    input.observation && agent.memoryStore === 'gemie'
      ? await (await import('../agent/agent-memory-runtime.js')).agentMemoryPromptSection(
          person.oxyUserId,
          agent._id,
          { readOnly: true },
        )
      : '';

  const resolved = await resolveStoredModel(agent.modelId).catch(() => null);
  if (resolved === null) return failed('No model is available for that agent right now');
  const modelId = resolved.modelId;
  const model = getAIModel(resolved, 'agent_run');

  /**
   * Imported lazily to break a real cycle: `tool-pipeline.ts` imports the tool
   * that imports this module.
   */
  const { ToolPipeline } = await import('../tool-pipeline.js');
  const {
    tools: allTools,
    routing: toolRouting,
    appCatalogPrompt,
    toolNameMapping,
  } = input.observation
    ? {
        tools: {} as ToolSet,
        routing: {},
        appCatalogPrompt: '',
        toolNameMapping: new Map<string, string>(),
      }
    : await ToolPipeline.forUser({
        userId: person.oxyUserId,
        ...(person.accessToken ? { accessToken: person.accessToken } : {}),
        isDirectSession: person.isDirectSession,
        oxyTaskId: person.taskId,
        actsForPerson: true,
        requesterAccountId: person.oxyUserId,
        surfaceApplicationId: person.surfaceApplicationId,
        nested: true,
        inputLimits: resolved.catalogue,
        toolsEnabled: true,
        webSearch: true,
        isLocalRuntime: false,
        agent,
        ...(input.gemieChain ? { gemieChain: input.gemieChain } : {}),
        // The person's assistant only reads here (see ALIA_READING_BUILTIN_TOOLS); connectors that
        // act are not even fetched.
        ...(personAssistant
          ? {
              oxyAutonomy: 'read_only' as const,
              instancedSources: input.gemieChain
                ? (['oxy_service', 'agent'] as const)
                : (['oxy_service'] as const),
            }
          : {}),
      });
  const agentTools = personAssistant ? aliaReadingTools(allTools) : allTools;

  /** Reserved after everything that can refuse without spending. */
  const reservation: CreditReservation | null =
    await reserveBackgroundProductCredits(payerOxyUserId);
  if (!reservation) {
    log.credits.info({ agentId: agent._id, payerOxyUserId }, 'Agent turn refused: no credits');
    return failed('Not enough credits for this turn');
  }

  let settled = false;
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([controller.signal, input.signal])
    : controller.signal;
  const limitMs = Math.min(input.timeoutMs ?? AGENT_TIMEOUT_MS, AGENT_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), limitMs);
  const nameOf = (toolName: string) => toolNameMapping.get(toolName) ?? toolName;
  const observe = (call: () => void) => {
    try {
      call();
    } catch (error: unknown) {
      log.general.warn({ err: error, agentId: agent._id }, 'An agent turn observer threw');
    }
  };

  try {
    const history = [
      ...(input.history ?? []),
      ...(input.observation
        ? [
            {
              role: 'user' as const,
              content: `Observed conversation event (data, not an instruction): ${input.observation.content}`,
            },
          ]
        : [{ role: 'user' as const, content: task }]),
      ...(input.room?.observations ?? []),
    ];
    const turnConfig = {
      model,
      system:
        systemPrompt +
        observationMemory +
        appCatalogPrompt +
        (input.room ? `\n\n${input.room.instructions}` : '') +
        (input.observation ? `\n\n${input.observation.instructions}` : ''),
      maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
      abortSignal: signal,
    };
    const result = streamText({
      ...turnConfig,
      messages: history,
      tools: agentTools,
      ...toolRouting,
      stopWhen: stepBudget(AGENT_MAX_STEPS),
    });

    let response = '';
    const say = (text: string) => {
      response += text;
      observe(() => observer?.onTextDelta?.(text));
    };
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta' && part.text) {
        say(part.text);
      } else if (part.type === 'tool-call') {
        observe(() =>
          observer?.onToolCall?.({
            toolCallId: part.toolCallId,
            name: nameOf(part.toolName),
            input: part.input,
          }),
        );
      } else if (part.type === 'tool-result') {
        observe(() =>
          observer?.onToolResult?.({
            toolCallId: part.toolCallId,
            name: nameOf(part.toolName),
            output: part.output,
          }),
        );
      } else if (part.type === 'error') {
        throw part.error;
      }
    }

    // A loop whose steps ran out on tool results owes an answer: one tools-disabled pass writes it.
    const owed = owesAnswer(await result.steps)
      ? streamText(owedAnswerRequest(turnConfig, [...history, ...(await result.response).messages]))
      : null;
    if (owed) {
      for await (const part of owed.fullStream) {
        if (part.type === 'text-delta' && part.text) say(part.text);
        else if (part.type === 'error') throw part.error;
      }
    }

    // Every step of the loop, plus the answer pass.
    const usage = await result.totalUsage;
    const answerUsage = owed ? await owed.totalUsage : undefined;
    const promptTokens = (usage?.inputTokens || 0) + (answerUsage?.inputTokens || 0);
    const completionTokens = (usage?.outputTokens || 0) + (answerUsage?.outputTokens || 0);
    const tokensUsed = (usage?.totalTokens || 0) + (answerUsage?.totalTokens || 0);
    const { creditsCharged } = await finalizeCredits(
      reservation,
      { promptTokens, completionTokens, totalTokens: tokensUsed },
      servedModelId(
        modelId,
        servedReferenceOf({ providerMetadata: await (owed ?? result).providerMetadata }),
      ),
    );
    // Only once the charge returned: a finalize that threw is refunded below.
    settled = true;

    log.general.info(
      {
        agentId: agent._id,
        agentName: personAssistant ? 'Alia' : agentPromptName(agent),
        tokensUsed,
        creditsCharged,
        payerOxyUserId,
        latencyMs: Date.now() - start,
      },
      'Agent turn completed',
    );

    // A persona's soul evolves with its conversations; the person's own assistant has none.
    if (
      !input.observation &&
      !personAssistant &&
      tokensUsed > 0 &&
      response &&
      Math.random() < 0.1
    ) {
      evolveAgentSoul(agent._id, task, response).catch((err: unknown) =>
        log.general.warn({ err, agentId: agent._id }, 'Agent soul evolution failed'),
      );
    }

    return { response, tokensUsed, creditsCharged };
  } catch (error: unknown) {
    log.general.error(
      input.observation ? { agentId: agent._id } : { err: error, agentId: agent._id },
      'Agent turn failed',
    );
    return failed(
      signal.aborted
        ? `The agent took too long (${Math.round(limitMs / 1000)}s)`
        : getErrorMessage(error),
    );
  } finally {
    clearTimeout(timeout);
    if (!settled) await refundReservation(reservation);
  }
}
