/**
 * Reacting with an emoji to the message being answered, on a channel that shows reactions (a
 * gemie's own Telegram bot). The tool only records the choice; the channel sets it on the message
 * (`setMessageReaction`) when the turn ends.
 */

import { tool } from 'ai';
import { z } from 'zod';

export const REACT_TOOL = 'reactToMessage';

/** The reactions Telegram lets a bot set on any chat's message. */
export const TELEGRAM_REACTIONS = [
  '👍',
  '👎',
  '❤',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '😢',
  '🎉',
  '🤩',
  '🙏',
  '👌',
  '😍',
  '💯',
  '🤣',
  '⚡',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '😴',
  '😭',
  '🤓',
  '👀',
  '😇',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '😎',
  '🤷',
] as const;

export type TelegramReaction = (typeof TELEGRAM_REACTIONS)[number];

/** The tool, and the reaction it chose once the turn is over (`null` when it chose none). */
export function buildReactionTool() {
  let reaction: TelegramReaction | null = null;
  return {
    tool: tool({
      description:
        'React with an emoji to the message you are answering, as people do in chats: to acknowledge it, or when a reaction says it better than words. Use it sparingly; you still answer in words when there is something to say.',
      inputSchema: z.object({ emoji: z.enum(TELEGRAM_REACTIONS) }),
      execute: async ({ emoji }) => {
        reaction = emoji;
        return `Reacted with ${emoji}.`;
      },
    }),
    chosen: (): TelegramReaction | null => reaction,
  };
}
