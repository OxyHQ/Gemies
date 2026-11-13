import type {
  GemieAccountChat,
  GemieAccountLink,
  GemieAccountMessage,
  GemieAccountPlatform,
  GemieAccountQr,
  GemieAccountSession,
} from '@gemies/server/internal';

/**
 * One messaging platform a person's account can be linked through (ADR 0035): WhatsApp, Telegram.
 *
 * Every platform answers the same contract (`@gemies/server/internal`'s account types), so the
 * routes the API calls are one router for all of them (`gateway-router.ts`) and nothing above this
 * interface knows which protocol it is speaking.
 */
export interface AccountGateway {
  /** The platform, as the API names it; also where its routes mount: `/accounts/<platform>`. */
  readonly platform: GemieAccountPlatform;

  /** Restore the sessions a restart left, and start listening. */
  initialize(): Promise<void>;
  /** Close every session without logging any out. */
  shutdown(): Promise<void>;

  /** The Oxy account a session belongs to, or `null` when there is no such session. */
  ownerOf(sessionId: string): Promise<string | null>;
  /** Start a new session for a person and wait for its first code. */
  link(oxyUserId: string): Promise<GemieAccountLink>;
  qr(sessionId: string): Promise<GemieAccountQr | null>;
  session(sessionId: string): Promise<GemieAccountSession | null>;
  /** Log the session out and forget it with everything synced through it. */
  remove(sessionId: string): Promise<void>;

  chats(sessionId: string, limit: number): Promise<GemieAccountChat[]>;
  messages(sessionId: string, chatId: string, limit: number): Promise<GemieAccountMessage[]>;
  /** Send through a live session; `null` when the session is not live. */
  send(sessionId: string, chatId: string, text: string): Promise<{ messageId: string } | null>;
}
