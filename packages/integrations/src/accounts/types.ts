import type { Router } from 'express';

/**
 * Interface for account adapters (WhatsApp, Telegram).
 * Account adapters manage the accounts a person links to a gemie, which answers what arrives on them.
 */
export interface AccountAdapter {
  /** Platform identifier ('whatsapp', 'telegram-gateway') */
  name: string;

  /** Initialize the adapter (restore sessions, etc.) */
  initialize(): Promise<void>;

  /** Graceful shutdown (disconnect all sessions) */
  shutdown(): Promise<void>;

  /** Express router for REST endpoints (connect, QR, status, chats, send, etc.) */
  getRouter(): Router;
}
