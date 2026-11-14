/**
 * `POST /me/channel-tasks/renew`: only the person's own present session renews their channels'
 * tasks, as themselves — never a service credential, never a channel turn, never an account the
 * body names.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ renew: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'selected-account' } as typeof req.user;
    req.accessToken = 'verified-session';
    if (req.header('x-fixture-service')) req.serviceApp = {} as typeof req.serviceApp;
    next();
  },
}));
vi.mock('../../lib/channel-task-authority.js', () => ({ renewDueChannelTasks: state.renew }));
vi.mock('../../lib/logger.js', () => ({ log: { channels: { error: vi.fn() } } }));
const { default: router } = await import('../me-channel-tasks.js');

let server: Server;
let origin: string;
beforeEach(async () => {
  vi.resetAllMocks();
  state.renew.mockResolvedValue({ renewed: [{ kind: 'account', id: 'account-1' }], failed: [] });
  const app = express();
  app.use(express.json());
  app.use('/me/channel-tasks', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function renew(headers: Record<string, string> = {}) {
  return fetch(`${origin}/me/channel-tasks/renew`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ accountId: 'someone-else', accessToken: 'forged' }),
  });
}

describe('renewing a person’s channels', () => {
  it('renews as the verified session, ignoring what the body names', async () => {
    const response = await renew();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      renewed: [{ kind: 'account', id: 'account-1' }],
      failed: [],
    });
    expect(state.renew).toHaveBeenCalledWith({
      accountId: 'selected-account',
      accessToken: 'verified-session',
    });
  });

  it('never renews from a service credential', async () => {
    expect((await renew({ 'x-fixture-service': '1' })).status).toBe(401);
    expect(state.renew).not.toHaveBeenCalled();
  });

  it('answers 503 when the renewal itself could not run', async () => {
    state.renew.mockRejectedValueOnce(new Error('database down'));
    const response = await renew();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('channel_task_unavailable');
  });
});
