import { tool } from 'ai';
import { z } from 'zod';
import {
  AutomationCreationError,
  createAutomationSchema,
  createStructuredAutomation,
} from '../structured-automation-creation.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import type { AgentTaskAuthority } from '../../domain/agent.js';
import { withDelivery } from '../automation-delivery.js';

/**
 * Create a normalized automation through the same domain service as HTTP.
 *
 * A gemie whose work runs as agent sessions (`taskAuthority = 'session'`) is responsible for the tasks
 * it creates, so `actorSelection` is fixed to it. A standing-authority gemie (Alia) runs a task herself
 * when none is named — the schema's default is her gemie — and may hand it to one of the person's
 * agents when they name one.
 */
export function createAutomationTool(
  userId: string,
  accessToken: string | undefined,
  gemie: { readonly _id: string; readonly taskAuthority: AgentTaskAuthority },
  /** The conversation the task is asked for in: its results are delivered there. */
  origin: { readonly conversationId?: string } = {},
) {
  const agentId = gemie.taskAuthority === 'session' ? gemie._id : undefined;
  const schema = agentId
    ? createAutomationSchema.extend({
        actorSelection: z
          .object({ mode: z.literal('fixed'), agentId: z.literal(agentId) })
          .default({ mode: 'fixed', agentId }),
      })
    : createAutomationSchema;
  return tool({
    description: [
      'Create an editable scheduled task, only once the user has clearly said what to do and when.',
      agentId
        ? 'You are responsible for this task: actorSelection is fixed to your own agent. For a one-time delayed reply or continuation, use scheduleFollowUp instead; it preserves this conversation and the exact date. Use this tool for recurring schedules or event-driven tasks.'
        : 'Alia is the actor by default: omit actorSelection and Alia runs the task, posting each result in a conversation of its own. Set it to one of their agents only when the user explicitly names one; never ask them to pick.',
      'Reminders, research and plain replies: actions, resources and dataFlow stay empty arrays; never invent an app or tool. Alia reads the user\'s own Oxy apps (inbox, notes…) during the task with no connect step, so "summarise my email every morning" declares no action.',
      'To be told WHEN something happens ("tell me when this page mentions X"), make a watch instead of a model run per tick: inputs.watch = { query: "<web search that would surface it>" } or { url: "<public page that would change>" }, with condition "change" (default: something new appears) or "contains" plus value. Schedule it often (hourly: "0 * * * *"); each tick is a cheap check and Alia runs only when the source changed. Prefer an official URL, else a precise query.',
      'Connected-app effects (send, create or change something in an Oxy app) are exact actions on resources the user asked for, using tool names from the current capability map.',
      agentId
        ? 'A one-time reply belongs to scheduleFollowUp, not to a recurring cron schedule.'
        : 'One-off task: put its exact local date in the cron day/month fields and set inputs.runOnce to true.',
      'Use executionMode execute and maximumAutonomy autonomous for scheduled work. Creating schedules future work; it never runs the task now.',
    ].join(' '),
    inputSchema: schema,
    execute: async (definition) => {
      try {
        const validated = schema.safeParse(definition);
        if (!validated.success) return { success: false, error: 'invalid_automation_definition' };
        const created = await createStructuredAutomation({
          ownerAccountId: userId,
          accessToken,
          definition: {
            ...validated.data,
            inputs: withDelivery(validated.data.inputs, origin.conversationId),
          },
        });
        return {
          success: true,
          ...created,
          card: {
            type: 'scheduled-task',
            data: {
              id: created.automation.id,
              objective: created.automation.objective,
              enabled: created.automation.enabled,
              trigger: created.automation.trigger,
            },
          },
        };
      } catch (error: unknown) {
        if (error instanceof AutomationCreationError) {
          return { success: false, error: error.code, ...error.context };
        }
        log.triggers.error(
          { err: error, ownerAccountId: userId },
          'Failed to create automation via tool',
        );
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
}
