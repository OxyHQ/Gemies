import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { GemieAccountPlatform } from '@gemies/server/internal';
import { getDb } from '../../db/index.js';
import {
  listConnectedGemieAccounts,
  type ConnectedAccountRow,
  type GemieAccountScope,
} from '../../db/integrations/connectedAccountRepository.js';
import { getErrorMessage } from '../errors/index.js';
import { listAccountChats, readAccountMessages, sendAccountMessage } from '../gemie-accounts.js';
import { log } from '../logger.js';

/** The tool names, one set for every platform (ADR 0035). */
export const ACCOUNT_TOOL_NAMES = [
  'listAccountChats',
  'readAccountMessages',
  'sendAccountMessage',
] as const;

const PLATFORM_LABELS: Record<GemieAccountPlatform, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

/**
 * The tools a turn uses its gemie's connected accounts with: the person's own WhatsApp or Telegram
 * that they linked to THIS gemie, and nothing else. Built only when the gemie has one connected
 * (and so only where a gateway runs), with the platform the model may name limited to those it
 * has: a tool that is shown is a tool the model keeps calling, and one with no account behind it
 * would fail on every call.
 */
export async function buildAccountTools(scope: GemieAccountScope): Promise<ToolSet> {
  if (!process.env.INTEGRATIONS_URL) return {};
  let accounts: ConnectedAccountRow[];
  try {
    accounts = await listConnectedGemieAccounts(getDb(), scope);
  } catch (err: unknown) {
    log.tools.warn({ err }, 'Could not read the connected accounts of a turn');
    return {};
  }
  // The newest connected account of each platform answers for it.
  const byPlatform = new Map<GemieAccountPlatform, ConnectedAccountRow>();
  for (const account of accounts) {
    if (!byPlatform.has(account.platform)) byPlatform.set(account.platform, account);
  }
  const platforms = [...byPlatform.keys()];
  const [first, ...rest] = platforms;
  if (first === undefined) return {};

  const platform = z
    .enum([first, ...rest])
    .describe(`Which account: ${platforms.map((p) => `${p} (${PLATFORM_LABELS[p]})`).join(', ')}`);
  const names = platforms.map((p) => PLATFORM_LABELS[p]).join(' and ');
  const accountOf = (name: GemieAccountPlatform) => byPlatform.get(name) as ConnectedAccountRow;

  /** Run a tool call, answering a failure in words the model can tell the person. */
  const run = async <T>(what: string, call: () => Promise<T>) => {
    try {
      return { success: true as const, ...(await call()) };
    } catch (error: unknown) {
      log.tools.error({ err: error }, `${what} failed`);
      return { success: false as const, message: getErrorMessage(error) };
    }
  };

  return {
    listAccountChats: tool({
      description: `The person's recent ${names} chats, as linked to you: names, chat ids, whether each is a group, unread counts and last-message previews.`,
      inputSchema: z.object({ platform }),
      execute: ({ platform: name }) =>
        run('listAccountChats', async () => ({
          chats: await listAccountChats(accountOf(name), scope.oxyUserId),
        })),
    }),
    readAccountMessages: tool({
      description: `Recent messages of one ${names} chat. Get its chat id from listAccountChats first.`,
      inputSchema: z.object({
        platform,
        chatId: z.string().min(1).describe('The chat id, from listAccountChats.'),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: ({ platform: name, chatId, limit }) =>
        run('readAccountMessages', async () => ({
          messages: await readAccountMessages(accountOf(name), scope.oxyUserId, chatId, limit),
        })),
    }),
    sendAccountMessage: tool({
      description: `Send a message from the person's ${names}. ONLY when the person explicitly asks. Get the chat id from listAccountChats first.`,
      inputSchema: z.object({
        platform,
        chatId: z.string().min(1).describe('The chat id, from listAccountChats.'),
        text: z.string().min(1).describe('The message text to send'),
      }),
      execute: ({ platform: name, chatId, text }) =>
        run('sendAccountMessage', async () =>
          sendAccountMessage(accountOf(name), scope.oxyUserId, chatId, text),
        ),
    }),
  };
}
