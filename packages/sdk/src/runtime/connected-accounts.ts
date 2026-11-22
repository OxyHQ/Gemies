import {
  action,
  type ActionView,
  type RecordView,
  skip,
  useStore,
  withStore,
} from '@oxy.so/bloom-data';
import { useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useEffect } from 'react';
import { rereadOn } from '../realtime/reread';
import { type GemieApi, useGemieApi } from './api';
import { answerSource, useAnswer } from './data/answer';
import { ACCOUNT, gemieRead } from './data/read';
import { errorStatus } from './error-utils';
import { ACCOUNT_ROUTES } from './routes';
import { useBoundAction } from './use-bound-action';

/**
 * A person's connected accounts (ADR 0035 as amended): the WhatsApp and Telegram (Business,
 * ADR 0037) accounts they connect ONCE, in Settings, and grant to the gemies that may use them.
 * At most one granted gemie answers what arrives on an account, as its replies say; every granted
 * gemie reads and sends through it when the person asks it or its tasks need it. Each is the
 * caller's own; the API never lists another person's. The Gemies and the Alia apps both manage them
 * through these hooks, `GemieConnectedAccounts` (Settings) and `GemieAccountGrants` (a gemie's
 * editor), from `@gemies/sdk/accounts`.
 */

export const GEMIE_ACCOUNT_PLATFORMS = ['whatsapp', 'telegram'] as const;
export type GemieAccountPlatform = (typeof GEMIE_ACCOUNT_PLATFORMS)[number];

/** Where an account's session is, as the API reports it (the gateway's own vocabulary). */
export const GEMIE_ACCOUNT_STATUSES = [
  'qr-pending',
  'connected',
  'disconnected',
  'paused',
  'logged-out',
  'failed',
] as const;
export type GemieAccountStatus = (typeof GEMIE_ACCOUNT_STATUSES)[number];

/** Who the answering gemie answers: everybody who writes, only the chosen chats, or nobody. */
export const GEMIE_ACCOUNT_REPLIES = ['everyone', 'chosen', 'nobody'] as const;
export type GemieAccountReplies = (typeof GEMIE_ACCOUNT_REPLIES)[number];
/** In a group: only when the message mentions or replies to the account, or never. */
export const GEMIE_ACCOUNT_GROUP_REPLIES = ['mentions', 'never'] as const;
export type GemieAccountGroupReplies = (typeof GEMIE_ACCOUNT_GROUP_REPLIES)[number];

/** One account, as `GET /me/accounts` lists it. */
export interface ConnectedAccount {
  _id: string;
  platform: GemieAccountPlatform;
  displayName: string | null;
  phoneNumber: string | null;
  status: GemieAccountStatus;
  /** Whether the platform lets a gemie write from it (Telegram Business); `null` elsewhere. */
  canReply: boolean | null;
  /** The gemies that may use it. */
  gemieIds: string[];
  /** The one that answers what arrives on it, or `null` when none does. */
  answeringGemieId: string | null;
  replies: GemieAccountReplies;
  replyChatIds: string[];
  groupReplies: GemieAccountGroupReplies;
  lastActiveAt: string | null;
}

/** A gemie an account can be granted to: Alia, and the person's own. */
export interface GrantableGemie {
  id: string;
  name: string;
}

/** One chat of an account, to choose which ones it answers. */
export interface GemieAccountChat {
  chatId: string;
  name: string;
  kind: 'direct' | 'group';
}

/**
 * A connection waiting to be finished: WhatsApp's code to scan, or Telegram's t.me link to open
 * (or scan from another device).
 */
export interface GemieAccountLink {
  accountId: string;
  qr: string | null;
}

export interface ConnectedAccountsAnswer {
  accounts: ConnectedAccount[];
  /** The gemies the person can grant an account to. */
  gemies: GrantableGemie[];
  /** The platforms this deployment can connect now: only those are offered. */
  platforms: GemieAccountPlatform[];
}

/**
 * The caller's accounts with their grants, and what can be connected: memory only (phone numbers
 * and a live code never reach the disk). Read again when the realtime `connections` event says they
 * changed, and after a reset.
 */
export const connectedAccounts = answerSource('gemies.connected-accounts', {
  ...gemieRead,
  key: (_api: GemieApi) => ACCOUNT,
  load: async ({ signal }, api) =>
    (await api.get<ConnectedAccountsAnswer>(ACCOUNT_ROUTES.all, { signal })).data,
});

rereadOn('connections', connectedAccounts);
rereadOn('reset', connectedAccounts);

/** The code of an account being connected, as its session reports it now. */
export const connectedAccountQr = answerSource('gemies.connected-account-qr', {
  ...gemieRead,
  key: (_api: GemieApi, accountId: string) => accountId,
  load: async ({ signal }, api, accountId) =>
    (
      await api.get<{ status: GemieAccountStatus; qr: string | null }>(
        `${ACCOUNT_ROUTES.one(accountId)}/qr`,
        { signal },
      )
    ).data,
});

/** An account's recent chats; one that has none to list (a 404) has none. */
export const connectedAccountChats = answerSource('gemies.connected-account-chats', {
  ...gemieRead,
  key: (_api: GemieApi, accountId: string) => accountId,
  load: async ({ signal }, api, accountId) => {
    try {
      const { data } = await api.get<{ chats: GemieAccountChat[] }>(
        `${ACCOUNT_ROUTES.one(accountId)}/chats`,
        { signal },
      );
      return data.chats;
    } catch (error) {
      if (errorStatus(error) === 404) return [];
      throw error;
    }
  },
});

/** The caller's accounts, each as its session is now with its grants, and what can be connected. */
export function useConnectedAccounts(): RecordView<ConnectedAccountsAnswer> {
  const api = useGemieApi();
  const { canUsePrivateApi } = useOxy();
  return useAnswer(connectedAccounts, ...(canUsePrivateApi ? [api] : [skip]));
}

/** Reads the caller's accounts again, in the store of the tree. */
function useRefreshConnectedAccounts(): () => void {
  const api = useGemieApi();
  const store = useStore();
  return useCallback(
    () => void withStore(store, () => connectedAccounts.refresh(api)),
    [api, store],
  );
}

/** How often a waiting code is read again: WhatsApp rotates its code every few seconds. */
const QR_REFRESH_MS = 4000;

/**
 * The code of an account being connected, refreshed while it waits (WhatsApp rotates its code
 * every few seconds; Telegram's link is renewed when it expires, and is gone once Telegram knows
 * who the person is). It stops once the session leaves `qr-pending`, and the list is read again
 * then, so the account shows as it is. Until the first read, the code the connection answered.
 */
export function useConnectedAccountQr(
  link: GemieAccountLink | null,
): RecordView<{ status: GemieAccountStatus; qr: string | null }> {
  const api = useGemieApi();
  const view = useAnswer(connectedAccountQr, ...(link ? [api, link.accountId] : [skip]));
  const refreshAccounts = useRefreshConnectedAccounts();
  const status = view.value?.status;
  const { refresh } = view;
  const waiting = link !== null && (status === undefined || status === 'qr-pending');
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), QR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  useEffect(() => {
    if (status !== undefined && status !== 'qr-pending') refreshAccounts();
  }, [status, refreshAccounts]);
  return {
    ...view,
    value: view.value ?? (link ? { status: 'qr-pending', qr: link.qr } : undefined),
  };
}

/** An account's recent chats, read while the person chooses which ones it answers. */
export function useConnectedAccountChats(accountId: string): RecordView<GemieAccountChat[]> {
  const api = useGemieApi();
  return useAnswer(connectedAccountChats, api, accountId);
}

/** What can be changed of an account: who answers it, and whom that gemie answers. */
export interface ConnectedAccountPatch {
  /** The gemie that answers it (granted it on the way), or `null` for none. */
  answeringGemieId?: string | null;
  replies?: GemieAccountReplies;
  replyChatIds?: string[];
  groupReplies?: GemieAccountGroupReplies;
}

/** Draws a change to the held accounts, as the calling action's layer. */
function drawAccounts(change: (accounts: ConnectedAccount[]) => ConnectedAccount[]): void {
  connectedAccounts.entity.update(ACCOUNT, (held) => ({
    ...held,
    value: { ...held.value, accounts: change([...held.value.accounts]) },
  }));
}

/** Every write ends with the list read again, so each screen shows the accounts as they now are. */
const rereadAccounts = (api: GemieApi) => void connectedAccounts.refresh(api);

/** Connects an account on a platform: the code (or link) that finishes it. */
export const connectAccount = action({
  run: async (api: GemieApi, platform: GemieAccountPlatform) =>
    (await api.post<GemieAccountLink>(ACCOUNT_ROUTES.all, { platform })).data,
  settle: (_link, api) => rereadAccounts(api),
});

/** Changes who answers an account and whom: drawn at once, put back if refused. */
export const updateAccount = action({
  optimistic: (_api: GemieApi, accountId: string, patch: ConnectedAccountPatch) =>
    drawAccounts((accounts) =>
      accounts.map((account) => (account._id === accountId ? { ...account, ...patch } : account)),
    ),
  run: async (api, accountId, patch) => {
    await api.patch(ACCOUNT_ROUTES.one(accountId), patch);
  },
  settle: (_result, api) => rereadAccounts(api),
});

/** Grants an account to a gemie (`granted: true`) or revokes it: drawn at once, put back if refused. */
export const grantAccount = action({
  optimistic: (_api: GemieApi, accountId: string, gemieId: string, granted: boolean) =>
    drawAccounts((accounts) =>
      accounts.map((account) =>
        account._id !== accountId
          ? account
          : {
              ...account,
              gemieIds: granted
                ? [...account.gemieIds.filter((id) => id !== gemieId), gemieId]
                : account.gemieIds.filter((id) => id !== gemieId),
            },
      ),
    ),
  run: async (api, accountId, gemieId, granted) => {
    const path = ACCOUNT_ROUTES.grant(accountId, gemieId);
    await (granted ? api.put(path) : api.delete(path));
  },
  settle: (_result, api) => rereadAccounts(api),
});

/** Removes an account (its session ends and its grants go): gone at once, back if refused. */
export const removeAccount = action({
  optimistic: (_api: GemieApi, accountId: string) =>
    drawAccounts((accounts) => accounts.filter((account) => account._id !== accountId)),
  run: async (api, accountId) => {
    await api.delete(ACCOUNT_ROUTES.one(accountId));
  },
  settle: (_result, api) => rereadAccounts(api),
});

/** Connecting, granting, who answers, and removing, as a component calls them. */
export function useConnectedAccountMutations(): {
  connect: ActionView<[platform: GemieAccountPlatform], GemieAccountLink>;
  update: ActionView<[accountId: string, patch: ConnectedAccountPatch], void>;
  grant: ActionView<[accountId: string, gemieId: string, granted: boolean], void>;
  remove: ActionView<[accountId: string], void>;
} {
  const api = useGemieApi();
  return {
    connect: useBoundAction(connectAccount, api),
    update: useBoundAction(updateAccount, api),
    grant: useBoundAction(grantAccount, api),
    remove: useBoundAction(removeAccount, api),
  };
}
