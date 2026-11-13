/**
 * The connected-account contract between the Gemies API and its integrations process (ADR 0035).
 *
 * A person links a WhatsApp or Telegram account to one gemie. The integrations process holds the
 * provider session and speaks this contract for every platform alike (`accounts/gateway-router.ts`
 * there); the API stores the account and decides who it answers (`routes/agents/accounts.ts`,
 * `lib/gemie-accounts.ts`). One vocabulary on both sides, so neither translates the other's.
 */

/** The platforms a gemie can be linked to, as the API stores them and the gateway mounts them. */
export const GEMIE_ACCOUNT_PLATFORMS = ['whatsapp', 'telegram'] as const;
export type GemieAccountPlatform = (typeof GEMIE_ACCOUNT_PLATFORMS)[number];

/**
 * Where a provider session is.
 *
 *  - `qr-pending`: waiting for the person to scan its code;
 *  - `connected`: live;
 *  - `disconnected`: dropped, and the gateway is reconnecting it;
 *  - `logged-out`: unlinked (from the phone, or removed here), and over;
 *  - `failed`: it could not reconnect, and needs linking again.
 */
export const GEMIE_ACCOUNT_STATUSES = [
  'qr-pending',
  'connected',
  'disconnected',
  'logged-out',
  'failed',
] as const;
export type GemieAccountStatus = (typeof GEMIE_ACCOUNT_STATUSES)[number];

/** A session as the gateway reports it. Fields the provider has not told it yet are absent. */
export interface GemieAccountSession {
  readonly status: GemieAccountStatus;
  readonly phoneNumber?: string | null;
  readonly displayName?: string | null;
}

/** `POST /accounts/:platform/sessions/connect`: the new session and its first code. */
export interface GemieAccountLink {
  readonly sessionId: string;
  readonly qr: string;
}

/** `GET …/sessions/:id/qr`: the current code while it waits, or none. */
export interface GemieAccountQr {
  readonly status: GemieAccountStatus;
  readonly qr: string | null;
}

/** One chat of a linked account. `chatId` is the platform's own (a JID, a Telegram peer id). */
export interface GemieAccountChat {
  readonly chatId: string;
  readonly name: string;
  readonly kind: 'direct' | 'group';
  readonly unreadCount: number;
  /** Seconds since the epoch, as the platforms count. */
  readonly lastMessageAt: number | null;
  readonly lastMessagePreview: string;
}

/** One message of a chat. */
export interface GemieAccountMessage {
  readonly id: string;
  readonly fromMe: boolean;
  readonly sender: string | null;
  readonly text: string;
  /** Seconds since the epoch. */
  readonly at: number;
}

/** What the gateway knows of a message that arrived, for the API to decide whether to answer it. */
export interface GemieAccountInbound {
  readonly chatId: string;
  readonly chatKind: 'direct' | 'group';
  /** Whether a group message mentions the linked account (or replies to it). */
  readonly mentionsAccount: boolean;
}

/** The API's answer to {@link GemieAccountInbound}. */
export interface GemieAccountInboundDecision {
  readonly answer: boolean;
}
