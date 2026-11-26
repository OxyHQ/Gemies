import type { Request, Response } from 'express';
import { makeChunk, writeContentChunk, writeStopChunk } from '../streaming-helpers.js';
import type { ExternalActivity, ExternalApprovalEvent } from '../../domain/external-agent.js';
import { buildCompletionResponse } from '../chat/response-shapes.js';
import type { SSEWriter } from '../chat/sse-writer.js';
import { saveConversationResult, type LifecycleContext } from '../chat-lifecycle.js';
import { getDb } from '../../db/index.js';
import { findExternalSession } from '../../db/agents/externalAgentRepository.js';
import { externalHistoryOf } from './history.js';
import { runExternalAgentTurn } from './turn.js';
import type { ActorActivity } from '../realtime/activity.js';

/**
 * Serves a direct (1:1) chat turn with an external agent (ADR 0030): the same OpenAI-shaped stream
 * the app already renders, with the deltas coming from the person's daemon instead of a model.
 *
 * Nothing is charged — the caller leaves the credit reservation unsettled and the handler's release
 * point refunds it. Returns true when an answer was delivered and stored.
 */
/** A tool the CLI used, as the conversation keeps it (`saveConversation`'s tool invocations). */
interface StoredToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'call' | 'result';
  args?: unknown;
  result?: unknown;
}

export async function serveExternalDirectTurn(input: {
  req: Request;
  res: Response;
  sse: SSEWriter;
  requestId: string;
  modelId: string;
  stream: boolean;
  agentId: string;
  messages: readonly { role: string; content?: unknown }[];
  lifecycle: LifecycleContext;
  signal: AbortSignal;
  /** Called once, just before the stream ends, to settle the coordinated agent turn. */
  beforeFinish?: () => Promise<void>;
  /** Server-loaded observations, encoded in the existing external task interface. */
  reactionContext?: string;
  /** What the person's other surfaces show while the agent answers (`lib/realtime/activity.ts`). */
  activity?: ActorActivity;
}): Promise<boolean> {
  const { res, sse, requestId, modelId } = input;
  const { task, history } = externalHistoryOf(input.messages);

  if (input.stream) {
    sse.ensureHeaders();
    sse.startKeepAlive();
    res.write(
      `data: ${JSON.stringify(makeChunk(requestId, modelId, [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]))}\n\n`,
    );
  }

  // A session opened from the app names the folder it works in (ADR 0043).
  const session = input.lifecycle.conversationId
    ? await findExternalSession(getDb(), {
        conversationId: input.lifecycle.conversationId,
        agentId: input.agentId,
      })
    : undefined;

  // What the CLI does on the way is shown the way any tool's work is: a call, then its result. Never
  // a file's contents or an output, only what the daemon reported (a path, a command).
  const toolInvocations: StoredToolInvocation[] = [];
  let toolIndex = 0;
  const onActivity = (activity: ExternalActivity): void => {
    input.activity?.set('tool', activity.tool);
    const toolCallId = `ext_${activity.id}`;
    let invocation = toolInvocations.find((t) => t.toolCallId === toolCallId);
    if (!invocation) {
      invocation = {
        toolCallId,
        toolName: activity.tool,
        state: 'call',
        args: activity.summary ? { summary: activity.summary } : {},
      };
      toolInvocations.push(invocation);
      if (input.stream && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify(
            makeChunk(requestId, modelId, [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex++,
                      id: toolCallId,
                      type: 'function',
                      function: { name: activity.tool, arguments: JSON.stringify(invocation.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]),
          )}\n\n`,
        );
      }
    }
    if (activity.status === 'running') return;
    const output = {
      status: activity.status,
      ...(activity.summary ? { summary: activity.summary } : {}),
    };
    invocation.state = 'result';
    invocation.result = output;
    if (input.stream && !res.writableEnded) {
      res.write(
        `event: alia.tool_result\ndata: ${JSON.stringify({
          eventVersion: 1,
          tool_call_id: toolCallId,
          name: activity.tool,
          output,
        })}\n\n`,
      );
    }
  };

  // The CLI asking the person for permission, and that question closing: two named events the
  // conversation turns into a card the person answers (`POST /agents/external/:id/approvals/:request`).
  const onApproval = (event: ExternalApprovalEvent): void => {
    if (!input.stream || res.writableEnded) return;
    if (event.kind === 'request') {
      res.write(
        `event: alia.cli_permission_request\ndata: ${JSON.stringify({
          eventVersion: 1,
          requestId: event.requestId,
          agentId: input.agentId,
          tool: event.tool,
          ...(event.summary ? { summary: event.summary } : {}),
          expiresAt: event.expiresAt,
        })}\n\n`,
      );
      return;
    }
    res.write(
      `event: alia.cli_permission_resolved\ndata: ${JSON.stringify({
        eventVersion: 1,
        requestId: event.requestId,
        decision: event.decision,
      })}\n\n`,
    );
  };

  const result = await runExternalAgentTurn({
    agentId: input.agentId,
    task: input.reactionContext ? `${task}\n\n${input.reactionContext}` : task,
    history,
    ...(input.lifecycle.conversationId ? { threadKey: input.lifecycle.conversationId } : {}),
    ...(session ? { cwd: session.cwd } : {}),
    ...(session?.cliSessionId ? { resumeId: session.cliSessionId } : {}),
    signal: input.signal,
    onActivity,
    onApproval,
    ...(input.stream
      ? {
          onTextDelta: (text: string) => {
            input.activity?.set('writing');
            if (res.writableEnded) return;
            writeContentChunk(res, requestId, modelId, text);
          },
        }
      : {}),
  });
  sse.stopKeepAlive();

  if (result.error !== undefined || result.response.trim() === '') {
    const error = {
      message: result.error ?? 'The external agent returned no answer',
      type: 'server_error',
      code: 'agent_unavailable',
      retryable: true,
    };
    if (sse.sent) sse.writeError(error);
    else res.status(503).json({ error });
    return false;
  }

  await input.beforeFinish?.();
  await saveConversationResult(
    input.lifecycle,
    result.response,
    toolInvocations.length > 0 ? toolInvocations : undefined,
  );

  if (input.stream) {
    writeStopChunk(res, requestId, modelId);
    sse.done();
  } else {
    res.json(
      buildCompletionResponse({
        requestId,
        model: modelId,
        content: result.response,
        finishReason: 'stop',
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        aliaUsage: {
          system_prompt_tokens: 0,
          billable_tokens: 0,
          credits_charged: 0,
          credits_remaining: 0,
          credit_warning: null,
        },
      }),
    );
  }
  return true;
}
