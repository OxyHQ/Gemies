import { currentStore } from '@oxy.so/bloom-data';
import { applyMessageReaction, type MessageReactionSnapshot } from '../message-reactions';
import { Conversations } from './conversations';
import { ThreadMessages, threadMessageKey } from './threads';

/**
 * A saved reaction, wherever its message is held: in its conversation's messages, and in a
 * thread's history or window. A copy newer than the update (a higher revision) is kept.
 */
export function storeReaction(update: MessageReactionSnapshot): void {
  currentStore().batch(() => {
    Conversations.patch(update.conversationId, (held) =>
      held.messages ? { messages: applyMessageReaction(held.messages, update) } : undefined,
    );
    const cursor = ThreadMessages.lookup(
      'message',
      threadMessageKey(update.conversationId, update.messageId),
    );
    if (cursor === undefined) return;
    ThreadMessages.patch(cursor, (held) =>
      update.revision !== undefined && (held.reactionRevision ?? 0) > update.revision
        ? undefined
        : {
            reactions: update.reactions,
            ...(update.revision === undefined ? {} : { reactionRevision: update.revision }),
          },
    );
  });
}
