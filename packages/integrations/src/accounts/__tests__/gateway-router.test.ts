/**
 * The one router every platform's gateway is served through (`gateway-router.ts`): the same
 * routes and answers for WhatsApp and Telegram, each held to the caller's own sessions.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountGateway } from '../gateway';
import { gatewayRouter } from '../gateway-router';

const OWNER = '0192f3a4-b5c6-7d8e-9f01-23456789abcd';

vi.mock('../../shared/internal-auth', () => ({
  internalAccount: (req: { headers: Record<string, string | undefined> }) =>
    req.headers['x-test-account'],
}));

const gateway = {
  platform: 'whatsapp',
  initialize: vi.fn(),
  shutdown: vi.fn(),
  ownerOf: vi.fn(async (sessionId: string) => (sessionId === 'mine' ? OWNER : 'someone-else')),
  link: vi.fn(async () => ({ sessionId: 'mine', qr: 'QR' })),
  qr: vi.fn(async () => ({ status: 'qr-pending' as const, qr: 'QR-2' })),
  session: vi.fn(async () => ({ status: 'connected' as const, phoneNumber: '+1' })),
  remove: vi.fn(async () => {}),
  chats: vi.fn(async () => []),
  messages: vi.fn(async () => []),
  send: vi.fn(async (): Promise<{ messageId: string } | null> => ({ messageId: 'm1' })),
} satisfies AccountGateway;

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/accounts/whatsapp', gatewayRouter(gateway));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => vi.clearAllMocks());

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/accounts/whatsapp${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-account': OWNER },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe('a gateway’s routes', () => {
  it('links a session for the verified account, never the one a body names', async () => {
    expect(await call('POST', '/sessions/connect', { oxyUserId: 'forged' })).toEqual({
      status: 200,
      body: { sessionId: 'mine', qr: 'QR' },
    });
    expect(gateway.link).toHaveBeenCalledWith(OWNER);
  });

  it('answers the caller’s own session, and another’s as not found', async () => {
    expect((await call('GET', '/sessions/mine/qr')).body).toEqual({
      status: 'qr-pending',
      qr: 'QR-2',
    });
    expect((await call('GET', '/sessions/mine/status')).body).toEqual({
      status: 'connected',
      phoneNumber: '+1',
    });
    expect((await call('DELETE', '/sessions/theirs')).status).toBe(404);
    expect(gateway.remove).not.toHaveBeenCalled();
  });

  it('removes a session', async () => {
    expect((await call('DELETE', '/sessions/mine')).status).toBe(204);
    expect(gateway.remove).toHaveBeenCalledWith('mine');
  });

  it('sends only a whole message through a live session', async () => {
    expect((await call('POST', '/sessions/mine/send', { chatId: 'c1' })).status).toBe(400);
    expect(await call('POST', '/sessions/mine/send', { chatId: 'c1', text: 'hi' })).toEqual({
      status: 200,
      body: { messageId: 'm1' },
    });
    gateway.send.mockResolvedValueOnce(null);
    expect((await call('POST', '/sessions/mine/send', { chatId: 'c1', text: 'hi' })).status).toBe(
      409,
    );
  });

  it('says what failed instead of hanging', async () => {
    gateway.chats.mockRejectedValueOnce(new Error('postgres unreachable'));
    expect(await call('GET', '/sessions/mine/chats')).toEqual({
      status: 500,
      body: { error: 'postgres unreachable' },
    });
  });
});
