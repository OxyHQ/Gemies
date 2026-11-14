/**
 * `/me/channel-tasks` — the caller's channels' Oxy tasks, renewed with their present session
 * (`lib/channel-task-authority.ts`).
 *
 * `POST /renew` renews every channel of theirs that needs it — a connected account a gemie answers,
 * a system bot link, a gemie bot they linked their Telegram to — when its task lapsed, was never
 * dated, or lapses inside the renewal window. The apps call it silently once a session
 * (`useChannelTaskRenewal`), as they call `POST /agents/:id/work` for each gemie's work, and the
 * one-tap page a notice links to calls it on the person's tap. It answers what it renewed and what
 * it could not: `{ renewed, failed }`, each a list of `{ kind, id }`.
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { renewDueChannelTasks } from '../lib/channel-task-authority.js';
import { log } from '../lib/logger.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

router.post('/renew', authenticateToken, async (req: Request, res: Response) => {
  // Only the person's own session mints a task: never a service, never a channel turn.
  if (!req.user?.id || !req.accessToken || req.serviceApp || req.channelContext) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    res.json(await renewDueChannelTasks({ accountId: req.user.id, accessToken: req.accessToken }));
  } catch (err: unknown) {
    log.channels.error({ err }, 'Channel task renewal failed');
    res
      .status(503)
      .json({ error: 'Could not renew channel tools', code: 'channel_task_unavailable' });
  }
});

export default router;
