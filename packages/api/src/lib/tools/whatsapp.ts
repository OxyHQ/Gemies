import { getDb } from '../../db/index.js';
import {
  findConnectedGemieAccount,
  type GemieAccountScope,
} from '../../db/integrations/connectedAccountRepository.js';
import { integrationsFetch } from '../integrations-client.js';
import { tool } from 'ai';
import { z } from 'zod';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

/**
 * Whether this turn's gemie can reach a WhatsApp at all: this deployment runs a gateway, and the
 * gemie has a CONNECTED WhatsApp account of the turn's person (ADR 0035).
 *
 * The three WhatsApp tools are offered only then: a tool whose backend is not there fails on every
 * call, and the model — told it exists — keeps calling it. Read at call time, so the answer is the
 * environment's and the account's now; a read that fails answers no.
 */
export async function whatsAppReachable(
  scope: GemieAccountScope,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!env.INTEGRATIONS_URL) return false;
  return findConnectedGemieAccount(getDb(), scope, 'whatsapp')
    .then((account) => account !== null)
    .catch(() => false);
}

interface WhatsAppChatSummary {
  name?: string;
  jid?: string;
  unreadCount?: number;
  lastMessagePreview?: string;
  lastMessageTimestamp?: number;
}

interface WhatsAppMessageSummary {
  fromMe?: boolean;
  pushName?: string;
  text?: string;
  timestamp?: number;
}

/**
 * Call the WhatsApp session of the turn's gemie, linked by the turn's person (ADR 0035). Only that
 * gemie's account: another gemie's WhatsApp of the same person is never reached from this turn.
 */
async function gatewayFetch<T = unknown>(
  scope: GemieAccountScope,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const connection = await findConnectedGemieAccount(getDb(), scope, 'whatsapp');
  if (!connection?.sessionId) throw new Error('WhatsApp account is not connected');
  const res = await integrationsFetch(
    scope.oxyUserId,
    `/accounts/whatsapp/sessions/${encodeURIComponent(connection.sessionId)}${path}`,
    {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    },
  );

  if (!res.ok) {
    throw new Error(`WhatsApp integration request failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}

/**
 * Get the user's recent WhatsApp conversations.
 */
export function createGetWhatsAppChatsTool(scope: GemieAccountScope) {
  return tool({
    description:
      "The user's recent WhatsApp chats: names, JIDs, unread counts, last-message previews.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const data = await gatewayFetch<{ chats?: WhatsAppChatSummary[] }>(scope, '/chats');
        const chats = data.chats || [];

        if (chats.length === 0) {
          return {
            success: true,
            message: 'No WhatsApp chats found. The session may still be syncing.',
          };
        }

        return {
          success: true,
          chats: chats.map((c) => ({
            name: c.name,
            jid: c.jid,
            unreadCount: c.unreadCount,
            lastMessage: c.lastMessagePreview || '',
            lastMessageTime: c.lastMessageTimestamp
              ? new Date(c.lastMessageTimestamp * 1000).toISOString()
              : null,
          })),
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'getChats error');
        return { success: false, message: getErrorMessage(error) };
      }
    },
  });
}

/**
 * Get recent messages from a specific WhatsApp chat.
 */
export function createGetWhatsAppMessagesTool(scope: GemieAccountScope) {
  return tool({
    description: 'Recent messages of one WhatsApp chat. Get its JID from getWhatsAppChats first.',
    inputSchema: z.object({
      jid: z
        .string()
        .describe(
          'The chat JID (e.g. "1234567890@s.whatsapp.net"). Get this from getWhatsAppChats.',
        ),
      limit: z.number().optional().default(20).describe('Number of messages to fetch (max 50)'),
    }),
    execute: async ({ jid, limit }) => {
      try {
        const data = await gatewayFetch<{ messages?: WhatsAppMessageSummary[] }>(
          scope,
          `/chats/${encodeURIComponent(jid)}/messages?limit=${limit}`,
        );
        const messages = data.messages || [];

        if (messages.length === 0) {
          return { success: true, message: 'No messages found in this chat.' };
        }

        return {
          success: true,
          messages: messages.map((m) => ({
            from: m.fromMe ? 'You' : m.pushName || 'Unknown',
            text: m.text,
            time: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
          })),
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'getMessages error');
        return { success: false, message: getErrorMessage(error) };
      }
    },
  });
}

/**
 * Send a WhatsApp message to a contact or group.
 */
export function createSendWhatsAppMessageTool(scope: GemieAccountScope) {
  return tool({
    description:
      'Send a WhatsApp message. ONLY when the user explicitly asks. Get the recipient JID from getWhatsAppChats first.',
    inputSchema: z.object({
      jid: z
        .string()
        .describe(
          'The recipient JID (e.g. "1234567890@s.whatsapp.net"). Get this from getWhatsAppChats.',
        ),
      message: z.string().describe('The message text to send'),
    }),
    execute: async ({ jid, message }) => {
      try {
        const data = await gatewayFetch<{ messageId?: string }>(scope, '/send', {
          method: 'POST',
          body: JSON.stringify({ jid, text: message }),
        });

        return {
          success: true,
          message: 'WhatsApp message sent successfully',
          messageId: data.messageId,
        };
      } catch (error: unknown) {
        log.tools.error({ err: error }, 'sendMessage error');
        return { success: false, message: getErrorMessage(error) };
      }
    },
  });
}
