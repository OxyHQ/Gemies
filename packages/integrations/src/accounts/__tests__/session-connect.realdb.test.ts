/**
 * `POST /sessions/connect` for WhatsApp, through the real session manager against
 * a real Postgres, with only the network client (Baileys) faked.
 *
 * The manager used to arm the QR wait and then call `startSession`, whose
 * `cleanupSocket` rejected that same wait with 'Session was reset' before
 * anything awaited it. Once the reset was followed by real I/O, that was an
 * unhandled rejection — which on Node ends the process — and the request got
 * 'Session was reset' instead of a QR. The fakes cross a macrotask on connect,
 * as the real clients do, so the rejection surfaces exactly as in production.
 */

import type { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePostgres, connectPostgres } from '../../db';

const fakes = vi.hoisted(() => {
  const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    nextMacrotask,
    waSockets: [] as Array<{ ev: EventEmitter }>,
    /** Set to make the fake Baileys version lookup fail, as a network error would. */
    waVersion: { fail: null as Error | null },
  };
});

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  const { EventEmitter: Emitter } = await import('node:events');
  const makeWASocket = () => {
    const sock = { ev: new Emitter(), end: () => {}, logout: async () => {}, user: undefined };
    fakes.waSockets.push(sock);
    return sock;
  };
  return {
    ...actual,
    default: makeWASocket,
    fetchLatestBaileysVersion: async () => {
      await fakes.nextMacrotask();
      if (fakes.waVersion.fail) throw fakes.waVersion.fail;
      return { version: [2, 3000, 1], isLatest: true };
    },
  };
});

// Imported after the mocks are registered (vi.mock is hoisted above these).
import { sessionManager as whatsapp } from '../whatsapp/session-manager';
import { whatsAppGateway } from '../whatsapp/gateway';

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

/** Let any rejection nobody handled reach `unhandledRejection`. */
async function settle(): Promise<void> {
  await fakes.nextMacrotask();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  connectPostgres(url);
});

afterAll(async () => {
  await whatsapp.shutdown();
  await closePostgres();
});

beforeEach(() => {
  unhandled.length = 0;
  fakes.waVersion.fail = null;
  process.on('unhandledRejection', recordUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', recordUnhandled);
});

describe('WhatsApp connect', () => {
  it('answers with the first QR and rejects nothing on the way', async () => {
    const { sessionId, qrPromise } = await whatsapp.createSession('wa-connect-owner');

    const sock = fakes.waSockets.at(-1);
    if (!sock) throw new Error('no socket was opened');
    sock.ev.emit('connection.update', { qr: 'wa-qr-1' });

    await expect(qrPromise).resolves.toBe('wa-qr-1');
    await settle();
    expect(unhandled).toEqual([]);
    expect(await whatsAppGateway.qr(sessionId)).toEqual({ status: 'qr-pending', qr: 'wa-qr-1' });
  });

  it('fails the request with the real cause when the socket cannot open', async () => {
    fakes.waVersion.fail = new Error('version lookup failed');

    await expect(whatsapp.createSession('wa-connect-owner')).rejects.toThrow(
      'version lookup failed',
    );
    await settle();
    expect(unhandled).toEqual([]);
  });
});
