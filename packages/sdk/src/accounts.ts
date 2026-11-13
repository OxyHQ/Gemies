/// <reference types="nativewind/types" />
/**
 * The connected-accounts leaf entry (ADR 0035): the WhatsApp and Telegram accounts a person links
 * to a gemie, and the panel that manages them. Its own entry so an app that does not draw it never
 * reaches its QR encoder.
 */
export { GemieAccounts } from './components/GemieAccounts';
export type { GemieAccountsProps } from './components/GemieAccounts';
export {
  GEMIE_ACCOUNT_GROUP_REPLIES,
  GEMIE_ACCOUNT_PLATFORMS,
  GEMIE_ACCOUNT_REPLIES,
  GEMIE_ACCOUNT_STATUSES,
  useGemieAccountChats,
  useGemieAccountMutations,
  useGemieAccountQr,
  useGemieAccounts,
} from './runtime/gemie-accounts';
export type {
  GemieAccount,
  GemieAccountChat,
  GemieAccountGroupReplies,
  GemieAccountLink,
  GemieAccountPlatform,
  GemieAccountReplies,
  GemieAccountsAnswer,
  GemieAccountStatus,
} from './runtime/gemie-accounts';
