import { createOxyTask, revokeOxyTask } from '../lib/oxy-task-authority.js';
import express from 'express';
import { resolveModel } from '../lib/chat-core.js';
import { ModelNotFoundError } from '../lib/models/errors.js';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateChannelBot } from '../middleware/channel-auth.js';
import { getDb } from '../db/index.js';
import {
  findBotById,
  findBotUser,
  findBotUserByAuthToken,
  findLinkedBotUser,
  findSystemBot,
  linkBotUser,
  replaceBotUserTask,
  logoutBotUser,
  setBotUserAuthToken,
  setBotUserConversation,
  setBotUserPreferredModel,
  unlinkBotUser,
  upsertBotUser,
} from '../db/integrations/botRepository.js';
import type { ChannelId } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';
import { personAssistantActor } from '../lib/gemie-oxy-actor.js';

const router = express.Router();

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================
// Linking a person to a system bot (authenticated users)
// ============================================
//
// A gemie's own Telegram bot is managed in its editor (`routes/agents/telegram-bot.ts`).

// Get link status for current user with a specific bot
router.get(
  '/:id/link-status',
  authenticateToken,
  async (req: express.Request<{ id: string }>, res) => {
    try {
      const db = getDb();
      const bot = await findBotById(db, req.params.id);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      const botUser = await findLinkedBotUser(db, bot.id, req.userId!);

      if (!botUser) {
        return res.json({ linked: false });
      }

      res.json({
        linked: true,
        username: botUser.username,
        displayName: botUser.displayName,
        linkedAt: botUser.linkedAt,
        oxyTaskState: botUser.oxyTaskState,
      });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Link status error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Link account to bot (with auth token)
router.post('/:id/link', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const { authToken } = req.body;
    if (!authToken) {
      return res.status(400).json({ error: 'Missing auth token' });
    }

    const db = getDb();
    const bot = await findBotById(db, req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findBotUserByAuthToken(db, bot.id, authToken);

    if (!botUser) {
      return res.status(404).json({ error: 'Auth token not found or expired' });
    }

    // `linkBotUser` CLEARS the token to NULL. `undefined` through drizzle is a
    // no-op, and a
    // redeemed one-time token would stay live for its remaining 15 minutes.
    await linkChannelTask(req, botUser, authToken);

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Link error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// A present own-account session can resume its existing channel link silently.
router.post(
  '/:id/reauthorize',
  authenticateToken,
  async (req: express.Request<{ id: string }>, res) => {
    if (!req.user?.id || !req.accessToken || req.serviceApp)
      return res.status(401).json({ error: 'Authentication required' });
    try {
      const db = getDb();
      const bot = await findBotById(db, req.params.id);
      const link =
        bot?.status === 'active' ? await findLinkedBotUser(db, bot.id, req.user.id) : null;
      if (!link) return res.status(404).json({ error: 'Linked bot not found' });
      if (link.oxyTaskState === 'active' && link.oxyTaskId)
        return res.json({ success: true, oxyTaskState: 'active' });
      const taskId = await createOxyTask({
        accessToken: req.accessToken,
        effectiveAccountId: req.user.id,
        actor: personAssistantActor(req.user.id),
        origin: { kind: 'automation', id: `channel:${link.id}` },
      });
      try {
        if (link.oxyTaskId) await revokeOxyTask(link.oxyTaskId);
        if (!(await replaceBotUserTask(db, link.id, req.user.id, link.oxyTaskId, taskId)))
          throw new Error('Channel binding changed');
      } catch (error) {
        await revokeOxyTask(taskId);
        throw error;
      }
      return res.json({ success: true, oxyTaskState: 'active' });
    } catch {
      return res.status(503).json({ error: 'channel_task_unavailable' });
    }
  },
);

// Unlink account from bot
router.post('/:id/unlink', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const bot = await findBotById(db, req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findLinkedBotUser(db, bot.id, req.userId!);

    if (!botUser) {
      return res.status(404).json({ error: 'No linked account found' });
    }

    if (botUser.oxyTaskId) await revokeOxyTask(botUser.oxyTaskId);
    await unlinkBotUser(db, botUser.id);

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Unlink error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link by platform + auth token (used by the authorize page)
router.post(
  '/platform/:platform/link',
  authenticateToken,
  async (req: express.Request<{ platform: string }>, res) => {
    try {
      const { authToken } = req.body;
      const { platform } = req.params;
      if (!authToken) {
        return res.status(400).json({ error: 'Missing auth token' });
      }

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found for platform' });
      }

      const botUser = await findBotUserByAuthToken(db, bot.id, authToken);

      if (!botUser) {
        return res.status(404).json({ error: 'Auth token not found or expired' });
      }

      await linkChannelTask(req, botUser, authToken);

      res.json({ success: true });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Platform link error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ============================================
// Internal routes (authenticated integrations workload)
// ============================================

function botAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const platform = req.params.platform as ChannelId;
  void authenticateChannelBot(platform)(req, res, next).catch(next);
}

// Create or update bot user
router.post(
  '/internal/:platform/users',
  botAuth,
  async (req: express.Request<{ platform: string }>, res) => {
    try {
      const { platform } = req.params;
      const { platformUserId, chatId, username, displayName, metadata } = req.body;

      if (!platformUserId || !chatId) {
        return res.status(400).json({ error: 'platformUserId and chatId are required' });
      }

      // Find the system bot for this platform
      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: `No bot configured for platform: ${platform}` });
      }

      // One statement rather than a read-then-branch: two concurrent inbound
      // messages from the same person raced the source's insert, and the loser
      // now converges on the winner's row instead of failing.
      const botUser = await upsertBotUser(db, {
        botId: bot.id,
        platform,
        platformUserId,
        chatId,
        username,
        displayName,
        metadata,
      });

      res.json({
        platform: botUser.platform,
        platformUserId: botUser.platformUserId,
        chatId: botUser.chatId,
        username: botUser.username,
        displayName: botUser.displayName,
        isLinked: botUser.isLinked,
        conversationId: botUser.conversationId,
        preferredModel: botUser.preferredModel,
        oxyUserId: botUser.oxyUserId,
      });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Create/update bot user error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get bot user by platform user ID
router.get(
  '/internal/:platform/users/:platformUserId',
  botAuth,
  async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
    try {
      const { platform, platformUserId } = req.params;

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: `No bot for platform: ${platform}` });
      }

      const botUser = await findBotUser(db, bot.id, platformUserId);
      if (!botUser) {
        return res.status(404).json({ error: 'Bot user not found' });
      }

      res.json({
        platform: botUser.platform,
        platformUserId: botUser.platformUserId,
        chatId: botUser.chatId,
        username: botUser.username,
        displayName: botUser.displayName,
        isLinked: botUser.isLinked,
        oxyUserId: botUser.oxyUserId,
        conversationId: botUser.conversationId,
        linkedAt: botUser.linkedAt,
        oxyTaskState: botUser.oxyTaskState,
        preferredModel: botUser.preferredModel,
      });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Get bot user error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Create auth request for bot user
router.post(
  '/internal/:platform/auth-request',
  botAuth,
  async (req: express.Request<{ platform: string }>, res) => {
    try {
      const { platform } = req.params;
      const { platformUserId } = req.body;
      if (!platformUserId) {
        return res.status(400).json({ error: 'platformUserId is required' });
      }

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: `No bot for platform: ${platform}` });
      }

      const botUser = await findBotUser(db, bot.id, platformUserId);
      if (!botUser) {
        return res.status(404).json({ error: 'Bot user not found' });
      }

      const authToken = generateAuthToken();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await setBotUserAuthToken(db, botUser.id, authToken, expiresAt);

      const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
      const authUrl = `${apiBaseUrl}/bots/internal/${platform}/verify?token=${authToken}`;

      res.json({
        authToken,
        authUrl,
        expiresAt,
      });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Auth request error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Verify token (redirect to app)
router.get(
  '/internal/:platform/verify',
  async (req: express.Request<{ platform: string }>, res) => {
    const { platform } = req.params;
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    try {
      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      const botUser = await findBotUserByAuthToken(db, bot.id, token);

      if (!botUser) {
        return res.status(404).json({ error: 'Token not found or expired' });
      }

      // Deliver the token in the URL fragment, NOT the query string. Fragments are
      // never sent to servers, so the short-lived auth token does not leak into
      // access logs, proxies, or the Referer header on the next navigation. The
      // channel-auth screen reads it from `window.location.hash` client-side.
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:4150';
      const fragment = `token=${encodeURIComponent(token)}&channel=${encodeURIComponent(platform)}`;
      res.redirect(`${appUrl}/channel-auth#${fragment}`);
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Verify error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Get token info
router.get(
  '/internal/:platform/users/token/:token',
  async (req: express.Request<{ platform: string; token: string }>, res) => {
    try {
      const { platform, token } = req.params;

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      const botUser = await findBotUserByAuthToken(db, bot.id, token);

      if (!botUser) {
        return res.status(404).json({ error: 'Token not found or expired' });
      }

      res.json({
        platformUserId: botUser.platformUserId,
        oxyUserId: botUser.oxyUserId,
        isLinked: botUser.isLinked,
        displayName: botUser.displayName || botUser.username || '',
      });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Token info error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Check token validity
router.get(
  '/internal/:platform/check-token/:token',
  async (req: express.Request<{ platform: string; token: string }>, res) => {
    try {
      const { platform, token } = req.params;

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.json({ valid: false, error: 'Bot not found' });
      }

      const botUser = await findBotUserByAuthToken(db, bot.id, token);

      if (!botUser) {
        return res.json({ valid: false, error: 'Token not found or expired' });
      }

      res.json({ valid: true, expiresAt: botUser.authTokenExpiry });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Check token error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Update conversation ID
router.post(
  '/internal/:platform/users/:platformUserId/conversation',
  botAuth,
  async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
    try {
      const { platform, platformUserId } = req.params;
      const { conversationId } = req.body;

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      const botUser = await findBotUser(db, bot.id, platformUserId);
      if (!botUser) {
        return res.status(404).json({ error: 'Bot user not found' });
      }

      await setBotUserConversation(db, botUser.id, conversationId ?? null);

      res.json({ success: true, conversationId });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Update conversation error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Update preferred model
router.post(
  '/internal/:platform/users/:platformUserId/model',
  botAuth,
  async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
    try {
      const { platform, platformUserId } = req.params;
      /**
       * A `publisher/model` from the catalogue, or `null` to go back to the
       * person's default (ADR 0012).
       */
      const model: unknown = req.body?.model ?? null;
      if (model !== null && typeof model !== 'string') {
        return res.status(400).json({ error: 'model must be a model id or null' });
      }
      if (typeof model === 'string') {
        try {
          await resolveModel(model);
        } catch (error: unknown) {
          if (error instanceof ModelNotFoundError) {
            return res
              .status(400)
              .json({ error: error.userMessage, code: ModelNotFoundError.WIRE_CODE });
          }
          throw error;
        }
      }

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      const botUser = await findBotUser(db, bot.id, platformUserId);
      if (!botUser) {
        return res.status(404).json({ error: 'Bot user not found' });
      }

      await setBotUserPreferredModel(db, botUser.id, model);

      res.json({ success: true, model });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Update model error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Logout bot user
router.post(
  '/internal/:platform/users/:platformUserId/logout',
  botAuth,
  async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
    try {
      const { platform, platformUserId } = req.params;

      const db = getDb();
      const bot = await findSystemBot(db, platform);
      if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
      }

      const botUser = await findBotUser(db, bot.id, platformUserId);
      if (!botUser) {
        return res.status(404).json({ error: 'Bot user not found' });
      }

      if (botUser.oxyTaskId) await revokeOxyTask(botUser.oxyTaskId);
      await logoutBotUser(db, botUser.id);

      res.json({ success: true, message: 'Logged out successfully' });
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Logout error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;

/** A channel link retains the actual linking person, never the bot owner's account. */
async function linkChannelTask(
  req: express.Request,
  botUser: { id: string; oxyTaskId: string | null },
  authToken: string,
): Promise<void> {
  if (!req.accessToken || !req.user?.id || req.serviceApp)
    throw new Error('A direct Oxy session is required to link a channel');
  const requesterAccountId = req.user.id;
  const taskId = await createOxyTask({
    accessToken: req.accessToken,
    effectiveAccountId: requesterAccountId,
    actor: personAssistantActor(requesterAccountId),
    origin: { kind: 'automation', id: `channel:${botUser.id}` },
  });
  try {
    if (botUser.oxyTaskId) await revokeOxyTask(botUser.oxyTaskId);
    const linked = await linkBotUser(getDb(), botUser.id, {
      oxyUserId: requesterAccountId,
      oxyTaskId: taskId,
      authToken,
    });
    if (!linked) throw new Error('Channel link token was already redeemed');
  } catch (error) {
    await revokeOxyTask(taskId);
    throw error;
  }
}
