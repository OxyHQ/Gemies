import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { GemieAccountPlatform } from '@gemies/server/internal';
import { getDb } from '../../db/index.js';
import {
  listAccountsGrantedTo,
  type GrantedConnectedAccount,
} from '../../db/integrations/connectedAccountRepository.js';
import { getErrorMessage } from '../errors/index.js';
import {
  listAccountChats,
  readAccountMessages,
  sendAccountMessage,
} from '../connected-accounts.js';
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
 * What a platform really offers, said to the model so it never claims more. Telegram Business
 * (ADR 0037) shares only private chats, only from when it was connected (the Bot API has no chat
 * list and no history), and lets a gemie write only where the contact wrote in the last 24 hours.
 */
const PLATFORM_LIMITS: Partial<Record<GemieAccountPlatform, string>> = {
  telegram:
    'Telegram: only private chats, and only what arrived since it was connected (older history and groups are not available); you can write only in chats where the contact wrote in the last 24 hours.',
};

/**
 * The key the model names an account by: its platform, then `_2`, `_3`… in the order the person
 * connected them, so a key stays the same for as long as the account does.
 */
function keyedAccounts(
  accounts: readonly GrantedConnectedAccount[],
): Map<string, GrantedConnectedAccount> {
  const oldestFirst = [...accounts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const counts = new Map<GemieAccountPlatform, number>();
  const keyed = new Map<string, GrantedConnectedAccount>();
  for (const account of oldestFirst) {
    const n = (counts.get(account.platform) ?? 0) + 1;
    counts.set(account.platform, n);
    keyed.set(n === 1 ? account.platform : `${account.platform}_${n}`, account);
  }
  return keyed;
}

/** One account as the model reads it: which it is, and whether this gemie answers it on its own. */
function describeAccount(key: string, account: GrantedConnectedAccount): string {
  const who = account.phoneNumber || account.displayName;
  const name = `${PLATFORM_LABELS[account.platform]}${who ? ` ${who}` : ''}`;
  return account.answers
    ? `${key} (${name}): you answer what arrives on it on your own, as the person chose`
    : `${key} (${name}): another gemie or nobody answers it; use it only when the person asks or a task of theirs needs it`;
}

/**
 * The tools a turn uses the person's connected accounts with: the WhatsApp and Telegram accounts
 * the person GRANTED this gemie (ADR 0035 as amended), and nothing else. A granted gemie reads and
 * sends when the person asks it or its tasks need it; the one that answers an account also replies
 * there on its own, which these tools say so the model knows which is which.
 *
 * Built only when the gemie was granted a connected account (and so only where a gateway runs),
 * with the account the model may name limited to those: a tool that is shown is a tool the model
 * keeps calling, and one with no account behind it would fail on every call.
 */
export async function buildAccountTools(scope: {
  readonly agentId: string;
  readonly oxyUserId: string;
}): Promise<ToolSet> {
  if (!process.env.INTEGRATIONS_URL) return {};
  let accounts: GrantedConnectedAccount[];
  try {
    accounts = await listAccountsGrantedTo(getDb(), scope);
  } catch (err: unknown) {
    log.tools.warn({ err }, 'Could not read the connected accounts of a turn');
    return {};
  }
  const keyed = keyedAccounts(accounts);
  const [first, ...rest] = [...keyed.keys()];
  if (first === undefined) return {};

  const listing = [...keyed].map(([key, account]) => describeAccount(key, account)).join('; ');
  const account = z.enum([first, ...rest]).describe(`Which of the person's accounts: ${listing}`);
  const platforms = new Set([...keyed.values()].map((granted) => granted.platform));
  const names = [...platforms].map((platform) => PLATFORM_LABELS[platform]).join(' and ');
  const limits = [...platforms]
    .map((platform) => PLATFORM_LIMITS[platform])
    .filter(Boolean)
    .map((limit) => ` ${limit}`)
    .join('');
  const accountOf = (key: string) => keyed.get(key) as GrantedConnectedAccount;

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
      description: `The person's recent ${names} chats, on an account they let you use: names, chat ids, whether each is a group, unread counts and last-message previews.${limits}`,
      inputSchema: z.object({ account }),
      execute: ({ account: key }) =>
        run('listAccountChats', async () => ({
          chats: await listAccountChats(accountOf(key), scope.oxyUserId),
        })),
    }),
    readAccountMessages: tool({
      description: `Recent messages of one ${names} chat. Get its chat id from listAccountChats first.${limits}`,
      inputSchema: z.object({
        account,
        chatId: z.string().min(1).describe('The chat id, from listAccountChats.'),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: ({ account: key, chatId, limit }) =>
        run('readAccountMessages', async () => ({
          messages: await readAccountMessages(accountOf(key), scope.oxyUserId, chatId, limit),
        })),
    }),
    sendAccountMessage: tool({
      description: `Send a message from the person's ${names}, as them. ONLY when the person asked for it, now or in a task or watch they set up. Get the chat id from listAccountChats first.${limits}`,
      inputSchema: z.object({
        account,
        chatId: z.string().min(1).describe('The chat id, from listAccountChats.'),
        text: z.string().min(1).describe('The message text to send'),
      }),
      execute: ({ account: key, chatId, text }) =>
        run('sendAccountMessage', async () =>
          sendAccountMessage(accountOf(key), scope.oxyUserId, chatId, text),
        ),
    }),
  };
}
