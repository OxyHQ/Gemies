/**
 * Conversation changes on the realtime socket (`docs/realtime.mdx`).
 *
 * Every writer of a conversation calls ONE of these after its write commits; what the event carries
 * is read back from the database, so a client receives exactly what `GET /conversations` and
 * `GET /conversations/:id` would have answered:
 *
 * - the sidebar row ({@link ConversationSummary}), which moves the conversation to the top with its
 *   preview and unread count, and the unread total of its gemie's thread;
 * - the messages it gained, when the writer appended them (`appendedFromSeq`), which an open
 *   conversation merges by id — the same id the sending client drew them under, so its own
 *   optimistic copy is replaced, never doubled;
 * - or `reload`, when the writer rewrote the thread (an edit, a regenerate, a client's full save),
 *   which an open conversation answers by reading it again.
 */

import { getDb } from '../../db/index.js';
import { findConversation, unreadPerAgent } from '../../db/chat/conversationRepository.js';
import { listMessagesFromSeq } from '../../db/chat/messageRepository.js';
import { toClientMessages } from '../chat/client-message.js';
import { publicAgentId } from '../../domain/alia-gemie.js';
import { summarizeConversations } from '../chat/conversation-summary.js';
import { log } from '../logger.js';
import { publishAccountEvent } from './publish.js';

/** More appended messages than this, or a larger body, and the event asks for a reload instead. */
const MAX_APPENDED_MESSAGES = 50;
const MAX_APPENDED_BYTES = 256 * 1024;

export interface ConversationChange {
  /** The writer appended messages from this `seq` on: they travel with the event. */
  readonly appendedFromSeq?: number;
  /**
   * An open conversation reads it again: the writer rewrote the thread, or appended rows with no
   * `seq` to send them by (a channel's bot turns).
   */
  readonly reload?: boolean;
}

/** Tell the person's surfaces a conversation changed. Never throws. */
export async function publishConversation(
  oxyUserId: string,
  conversationId: string,
  change: ConversationChange = {},
): Promise<void> {
  try {
    const db = getDb();
    const row = await findConversation(db, oxyUserId, conversationId);
    if (!row) return;
    const [[conversation], unread, appended] = await Promise.all([
      summarizeConversations(db, oxyUserId, [row]),
      unreadPerAgent(db, oxyUserId, [row.agentId]),
      change.appendedFromSeq === undefined
        ? Promise.resolve(null)
        : listMessagesFromSeq(db, oxyUserId, conversationId, change.appendedFromSeq),
    ]);
    let messages = appended === null ? null : toClientMessages(appended);
    let reload = change.reload === true;
    if (
      messages !== null &&
      (messages.length > MAX_APPENDED_MESSAGES ||
        JSON.stringify(messages).length > MAX_APPENDED_BYTES)
    ) {
      messages = null;
      reload = true;
    }
    await publishAccountEvent(oxyUserId, 'conversation', {
      conversation,
      // The gemie's whole thread (many conversations): the sidebar's gemie row shows this.
      thread: { agentId: publicAgentId(row.agentId), unreadCount: unread.get(row.agentId) ?? 0 },
      ...(messages === null || messages.length === 0 ? {} : { appended: messages }),
      ...(reload ? { reload: true } : {}),
    });
  } catch (err: unknown) {
    log.chat.warn({ err, conversationId }, 'Could not publish a conversation change');
  }
}

/**
 * Tell the person's surfaces a conversation is gone, with its gemie's thread total when the caller
 * knows the gemie (`agentId`, stored id). Never throws.
 */
export async function publishConversationDeleted(
  oxyUserId: string,
  conversationId: string,
  agentId?: string,
): Promise<void> {
  let thread: { agentId: string | null; unreadCount: number } | undefined;
  if (agentId !== undefined) {
    try {
      const unread = await unreadPerAgent(getDb(), oxyUserId, [agentId]);
      thread = { agentId: publicAgentId(agentId), unreadCount: unread.get(agentId) ?? 0 };
    } catch (err: unknown) {
      log.chat.warn({ err, conversationId }, 'Could not total a gemie thread after a delete');
    }
  }
  await publishAccountEvent(oxyUserId, 'conversation.deleted', {
    conversationId,
    ...(thread === undefined ? {} : { thread }),
  });
}
