/**
 * Where a task delivers what it finds: the conversation it was asked for in, when it was asked in
 * one. A task asked on a gemie's Telegram bot answers in that Telegram chat and in the same
 * conversation in Gemies (`postAgentMessage` relays a bot conversation's messages to Telegram);
 * one asked in the app answers in that app conversation.
 *
 * Kept in the task's `inputs` under {@link AUTOMATION_DELIVERY_INPUT_KEY}, written by the server
 * from the turn, never by the model (`tools/automation-create.ts` overwrites whatever it sent). It
 * grants nothing: `postAgentMessage` posts only into a conversation of the task's own person with
 * the task's own gemie, and a task with none, or whose conversation is gone, posts to the gemie's
 * thread as before.
 */

export const AUTOMATION_DELIVERY_INPUT_KEY = 'deliverTo';

/** The task's inputs, with its delivery set from the turn and nothing the model wrote there. */
export function withDelivery(
  inputs: Record<string, unknown>,
  conversationId: string | undefined,
): Record<string, unknown> {
  const { [AUTOMATION_DELIVERY_INPUT_KEY]: _ignored, ...rest } = inputs;
  return conversationId ? { ...rest, [AUTOMATION_DELIVERY_INPUT_KEY]: { conversationId } } : rest;
}

/** The conversation a task's results go to, or `undefined` for the gemie's thread. */
export function deliveryConversationOf(
  inputs: Record<string, unknown> | null | undefined,
): string | undefined {
  const deliverTo = inputs?.[AUTOMATION_DELIVERY_INPUT_KEY];
  if (!deliverTo || typeof deliverTo !== 'object') return undefined;
  const conversationId = (deliverTo as { conversationId?: unknown }).conversationId;
  return typeof conversationId === 'string' && conversationId !== '' ? conversationId : undefined;
}
