import { publishAccountEvent } from '../../realtime/publish.js';

/** The durable reaction state, for every surface of the owner (`message.reaction` on `rt`). */
export interface ConversationReactionUpdate {
  readonly conversationId: string;
  readonly messageId: string;
  readonly reactions: readonly string[];
  readonly revision: number;
  readonly mutationId: string;
}

/** Call after the mutation commits; a reconnecting client replays it from the account's log. */
export async function publishConversationReaction(
  userId: string,
  update: ConversationReactionUpdate,
): Promise<void> {
  await publishAccountEvent(userId, 'message.reaction', update);
}
