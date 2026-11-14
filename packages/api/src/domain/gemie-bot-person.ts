/**
 * Who a gemie's own Telegram bot recognises (ADR 0037, amendment): the person who connected it,
 * writing in private from the Telegram account they linked to it, while the authority they granted
 * the gemie there stands. Never in a group, where everybody reads the answer. Everybody else on the
 * bot is a third party.
 *
 * One predicate for the two places that ask: the bot's message route, which decides whose turn it
 * is, and the channel middleware, which verifies the identity `/alia/chat` then runs as.
 */
export function isPersonTurn(
  bot: { readonly linkedTelegramUserId: string | null },
  message: { readonly chatKind: 'direct' | 'group'; readonly from: { readonly id: string } },
  /** The task they granted, while it stands (`liveChannelTaskId` in `channel-task.ts`). */
  liveTaskId: string | undefined,
): boolean {
  return (
    message.chatKind === 'direct' &&
    bot.linkedTelegramUserId !== null &&
    liveTaskId !== undefined &&
    message.from.id === bot.linkedTelegramUserId
  );
}

/** The conversation a Telegram chat of a gemie's bot is: one per chat, private or group. */
export function botConversationId(bot: { readonly botId: string }, chatId: string): string {
  return `telegram:${bot.botId}:${chatId}`;
}

/** The bot and chat a conversation is, when it is one of a gemie bot's chats. */
export function botChatOf(conversationId: string): { botId: string; chatId: string } | null {
  const [, botId, chatId] = /^telegram:(\d+):(-?\d+)$/.exec(conversationId) ?? [];
  return botId && chatId ? { botId, chatId } : null;
}
