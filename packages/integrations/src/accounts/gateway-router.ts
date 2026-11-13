import { Router, type Request, type Response } from 'express';
import { accountOwnership } from '../shared/account-ownership';
import { createLogger } from '../shared/logger';
import { errorMessage } from '../shared/utils';
import type { AccountGateway } from './gateway';

type SessionRequest = Request<Record<string, string>>;

/** How many chats and messages one read returns at most. */
const MAX_CHATS = 50;
const MAX_MESSAGES = 50;

/**
 * The routes the API calls for one platform, mounted at `/accounts/<platform>` behind the internal
 * workload and account-context checks. The same router for every platform: only the gateway
 * differs. Every `/sessions/:sessionId…` route is the caller's own session (`accountOwnership`).
 */
export function gatewayRouter(gateway: AccountGateway): Router {
  const logger = createLogger(`accounts/${gateway.platform}`);
  const router = Router();
  router.use(accountOwnership((sessionId) => gateway.ownerOf(sessionId)));

  /** Answer with a handler's result, or with its failure as a 500 that names it. */
  const handle =
    (what: string, run: (req: SessionRequest, res: Response) => Promise<unknown>) =>
    async (req: SessionRequest, res: Response) => {
      try {
        await run(req, res);
      } catch (error: unknown) {
        logger.error(`${what} failed:`, error);
        if (!res.headersSent) res.status(500).json({ error: errorMessage(error) || what });
      }
    };

  router.post(
    '/sessions/connect',
    handle('Linking', async (req, res) => {
      res.json(await gateway.link(String(req.body.oxyUserId)));
    }),
  );

  router.get(
    '/sessions/:sessionId/qr',
    handle('Reading the code', async (req, res) => {
      const qr = await gateway.qr(req.params.sessionId);
      if (!qr) return res.status(404).json({ error: 'Session not found' });
      res.json(qr);
    }),
  );

  router.get(
    '/sessions/:sessionId/status',
    handle('Reading the session', async (req, res) => {
      const session = await gateway.session(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    }),
  );

  router.delete(
    '/sessions/:sessionId',
    handle('Removing the session', async (req, res) => {
      await gateway.remove(req.params.sessionId);
      res.status(204).end();
    }),
  );

  router.get(
    '/sessions/:sessionId/chats',
    handle('Listing chats', async (req, res) => {
      res.json({ chats: await gateway.chats(req.params.sessionId, MAX_CHATS) });
    }),
  );

  router.get(
    '/sessions/:sessionId/chats/:chatId/messages',
    handle('Reading messages', async (req, res) => {
      const limit = Math.min(Number.parseInt(String(req.query.limit), 10) || 20, MAX_MESSAGES);
      res.json({
        messages: await gateway.messages(req.params.sessionId, req.params.chatId, limit),
      });
    }),
  );

  router.post(
    '/sessions/:sessionId/send',
    handle('Sending', async (req, res) => {
      const { chatId, text } = req.body as { chatId?: unknown; text?: unknown };
      if (typeof chatId !== 'string' || !chatId || typeof text !== 'string' || !text) {
        return res.status(400).json({ error: 'chatId and text are required' });
      }
      const sent = await gateway.send(req.params.sessionId, chatId, text);
      if (!sent) return res.status(409).json({ error: 'The account is not connected' });
      res.json(sent);
    }),
  );

  router.post(
    '/sessions/:sessionId/notify',
    handle('Notifying', async (req, res) => {
      const { text } = req.body as { text?: unknown };
      if (typeof text !== 'string' || !text) {
        return res.status(400).json({ error: 'text is required' });
      }
      if (!gateway.notify) {
        return res.status(404).json({ error: `${gateway.platform} cannot notify its person` });
      }
      const sent = await gateway.notify(req.params.sessionId, text);
      if (!sent) {
        return res
          .status(409)
          .json({ error: 'The account is not linked to its person on the platform yet' });
      }
      res.json(sent);
    }),
  );

  return router;
}
