/**
 * What a gemie says on its own Telegram bot when someone asks for its person's apps in a turn that
 * cannot reach them (a third party's, ADR 0037 amendment): how that becomes possible, never that
 * the capability does not exist.
 *
 * A prompt telling the model so was not enough: asked for "mi email" or "un mensaje en 1 minuto",
 * it answered "esa capacidad no está disponible para mí", and once a chat held that answer every
 * later turn repeated it. A tool the model calls for those requests answers deterministically, from
 * what the bot actually is: not linked yet, linked to someone else, or in a group.
 */

import { tool } from 'ai';
import { z } from 'zod';

export const PERSONAL_ACCESS_TOOL = 'personalAppsAccess';

export function buildPersonalAccessTool(input: {
  /** The gemie's name. */
  readonly name: string;
  /** How the bot's person links their Telegram, in words. */
  readonly linkSteps: string;
  /** Whether the bot's person has linked their Telegram to it already. */
  readonly personLinked: boolean;
  readonly chatKind: 'direct' | 'group';
}) {
  const { name, linkSteps } = input;
  const answer =
    input.chatKind === 'group'
      ? `In a group ${name} never uses its person's apps, because everybody reads the answer. Ask its person to write to ${name} in a private chat${input.personLinked ? '' : `, once they link their Telegram: ${linkSteps}`}.`
      : input.personLinked
        ? `${name} uses its person's apps (email, calendar, files, connected accounts, memory, scheduled messages and tasks) only in its person's own private chat, from the Telegram account they linked. This sender is not that account, so it cannot be done for them here.`
        : `${name} can do it here once its person links their Telegram to ${name}: ${linkSteps}. From then on, in this private chat, ${name} reads their email, schedules messages and reminders, and uses their apps, accounts and memory, as in Gemies. If you are that person, link it and ask again.`;
  return tool({
    description: `Someone asks you to read or act on email, a calendar, files, connected accounts or memory, or to send a message later, set a reminder or schedule a task. Call this first, and tell them what it answers, in their language. Never say such a capability does not exist: earlier answers in this chat that said so were wrong.`,
    inputSchema: z.object({
      asked: z.string().max(200).describe('What they asked for, in a few words'),
    }),
    execute: async () => answer,
  });
}
