/// <reference types="nativewind/types" />
/**
 * The connected-accounts leaf entry (ADR 0035 as amended): the WhatsApp and Telegram accounts a
 * person connects once and grants to their gemies. `GemieConnectedAccounts` is Settings ›
 * Connected accounts; `GemieAccountGrants` is the list of them a gemie's editor shows, one switch
 * each. Its own entry so an app that does not draw them never reaches the QR encoder.
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
