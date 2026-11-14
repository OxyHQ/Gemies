import type { MessageContent } from '../types';

/**
 * A gemie's own message that carries no words: a run the person asked for (a scheduled reply, a
 * task) that ended without an answer. The server stores it as one `{ type: 'failure', code }` part
 * (`packages/api/src/domain/conversation.ts`) and the thread draws it in the reader's language,
 * never the run's status line.
 */
export type MessageFailureCode = 'task_unfinished';

/** The failure a message is, when it is one. */
export function messageFailureOf(content: MessageContent): MessageFailureCode | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part.type === 'failure' && part.code === 'task_unfinished') return part.code;
  }
  return null;
}
