/// <reference types="nativewind/types" />
/**
 * The connected-accounts leaf entry (ADR 0035 as amended): the WhatsApp and Telegram accounts a
 * person connects once and grants to their gemies. `GemieConnectedAccounts` is Settings ›
 * Connected accounts; `GemieAccountGrants` is the list of them a gemie's editor shows, one switch
 * each. Its own entry so an app that does not draw them never reaches the QR encoder.
 *
 * Every channel's Oxy task is renewed from here too (`runtime/channel-tasks.ts`): mount
 * `useChannelTaskRenewal` once where the app is signed in, and `useReauthorizeChannels` on the page
 * a channel's notice opens.
 */
export { GemieAccountGrants } from './components/accounts/GemieAccountGrants';
export type { GemieAccountGrantsProps } from './components/accounts/GemieAccountGrants';
export { GemieConnectedAccounts } from './components/accounts/GemieConnectedAccounts';
export type { GemieConnectedAccountsProps } from './components/accounts/GemieConnectedAccounts';
export {
  GEMIE_ACCOUNT_GROUP_REPLIES,
  GEMIE_ACCOUNT_PLATFORMS,
  GEMIE_ACCOUNT_REPLIES,
  GEMIE_ACCOUNT_STATUSES,
  useConnectedAccountChats,
  useConnectedAccountMutations,
  useConnectedAccountQr,
  useConnectedAccounts,
} from './runtime/connected-accounts';
export type {
  ConnectedAccount,
  ConnectedAccountPatch,
  ConnectedAccountsAnswer,
  GemieAccountChat,
  GemieAccountGroupReplies,
  GemieAccountLink,
  GemieAccountPlatform,
  GemieAccountReplies,
  GemieAccountStatus,
  GrantableGemie,
} from './runtime/connected-accounts';
export {
  CHANNEL_TASK_KINDS,
  renewChannelTasks,
  useChannelTaskRenewal,
  useReauthorizeChannels,
} from './runtime/channel-tasks';
export type { ChannelTaskKind, ChannelTaskRef, ChannelTaskRenewal } from './runtime/channel-tasks';
