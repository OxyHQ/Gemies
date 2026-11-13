import type { VerifiedChannelContext } from '../types/channel-context.js';
import type { Request, Response, NextFunction } from 'express';
import {
  GEMIES_INTEGRATIONS_WORKLOAD_ID,
  GEMIES_CHANNEL_HEADER,
  GEMIES_PLATFORM_USER_HEADER,
  GEMIES_CHANNEL_SESSION_HEADER,
  GEMIES_CHANNEL_BOT_HEADER,
  isGemiesWorkload,
} from '@gemies/server/internal';
import { isLiveEntityId } from '@oxy.so/db';
import { oxy } from '../lib/oxy.js';
import { getDb } from '../db/index.js';
import { findSystemBot, findBotUser } from '../db/integrations/botRepository.js';
import { findConnectedAccountBySession } from '../db/integrations/connectedAccountRepository.js';
import { findActiveGemieBotByTelegramId } from '../db/integrations/gemieBotRepository.js';
import { isPersonTurn } from '../domain/gemie-bot-person.js';
import type { ChannelId } from '../lib/channels/types.js';

export function channelAccountOf(req: Request): string | undefined {
  return req.channelContext?.accountId;
}

/** Service tokens minted for Alia; built once, the audience is the server's own. */
const serviceTokenAuth = oxy.middleware.service();

/** Authenticate the exact integrations workload. Brand, headers and API keys confer no trust. */
async function requireIntegrations(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (
    req.headers['x-oxy-user-id'] !== undefined ||
    req.headers['x-oxy-requester-token'] !== undefined
  ) {
    res.status(403).json({ error: 'Channel identity must come from its provider link' });
    return;
  }
  await serviceTokenAuth(req, res, () => {
    const principal = req.serviceApp;
    if (
      !isGemiesWorkload(
        principal && { ...principal, applicationId: principal.appId },
        process.env.GEMIES_INTEGRATIONS_WORKLOAD_ID || GEMIES_INTEGRATIONS_WORKLOAD_ID,
      )
    ) {
      res.status(403).json({ error: 'Integrations workload required' });
      return;
    }
    // The shared service verifier stores the incoming workload bearer. It is
    // never the local channel account's foreground session credential.
    delete req.accessToken;
    next();
  });
}

/** Routes only the integrations process calls, acting for no channel account. */
export async function authenticateIntegrations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireIntegrations(req, res, next);
}

/** Administrative bot endpoints are private to the integrations process. */
export function authenticateChannelBot(channelType: ChannelId) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await requireIntegrations(req, res, () => {
      if (req.headers[GEMIES_CHANNEL_HEADER] !== channelType) {
        res.status(403).json({ error: 'Channel mismatch' });
        return;
      }
      req.channelType = channelType;
      next();
    });
  };
}

export function hasChannelContext(req: Request): boolean {
  return req.headers[GEMIES_CHANNEL_HEADER] !== undefined;
}

/** Resolve the account from the live provider link, never from an account header.
 * A channel context is local product authority; it is not an Oxy user session. */
export async function authenticateChannelAccount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireIntegrations(req, res, () => {
    void resolveChannelAccount(req, res, next);
  });
}

async function resolveChannelAccount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const platform = req.headers[GEMIES_CHANNEL_HEADER];
    const platformUserId = req.headers[GEMIES_PLATFORM_USER_HEADER];
    const sessionId = req.headers[GEMIES_CHANNEL_SESSION_HEADER];
    const gemieBotId = req.headers[GEMIES_CHANNEL_BOT_HEADER];
    if (
      typeof platform !== 'string' ||
      (platformUserId !== undefined && sessionId !== undefined) ||
      (gemieBotId !== undefined && (sessionId !== undefined || platformUserId === undefined))
    ) {
      res.status(401).json({ error: 'Channel context required' });
      return;
    }
    let context: VerifiedChannelContext | undefined;
    if (
      platform === 'telegram' &&
      typeof gemieBotId === 'string' &&
      gemieBotId.length > 0 &&
      typeof platformUserId === 'string' &&
      platformUserId.length > 0
    ) {
      // A gemie bot's person, only from the Telegram account they proved is theirs, in private
      // (the integrations process asks only after the API said `personTurn`), and only with the
      // authority they granted the gemie there. Anybody else on the bot is never an account here.
      const bot = await findActiveGemieBotByTelegramId(getDb(), gemieBotId);
      if (
        bot?.oxyTaskId &&
        isLiveEntityId(bot.userId) &&
        isPersonTurn(bot, { chatKind: 'direct', from: { id: platformUserId } })
      ) {
        context = {
          kind: 'gemie_bot',
          accountId: bot.userId,
          gemieId: bot.agentId,
          platform,
          identityId: bot.id,
          taskId: bot.oxyTaskId,
        };
      }
    } else if (
      platform === 'discord' &&
      typeof platformUserId === 'string' &&
      platformUserId.length > 0
    ) {
      const bot = await findSystemBot(getDb(), platform);
      const link =
        bot?.status === 'active' ? await findBotUser(getDb(), bot.id, platformUserId) : null;
      if (link?.isLinked && link.oxyUserId && isLiveEntityId(link.oxyUserId)) {
        context = {
          kind: 'bot',
          accountId: link.oxyUserId,
          platform,
          identityId: link.id,
          ...(link.oxyTaskState === 'active' && link.oxyTaskId ? { taskId: link.oxyTaskId } : {}),
        };
      }
    } else if (
      (platform === 'whatsapp' || platform === 'telegram') &&
      typeof sessionId === 'string' &&
      sessionId.length > 0
    ) {
      const connection = await findConnectedAccountBySession(getDb(), platform, sessionId);
      if (connection && isLiveEntityId(connection.oxyUserId)) {
        context = {
          kind: 'account',
          accountId: connection.oxyUserId,
          // The gemie its person chose to answer it (ADR 0035), never one the request names; `null`
          // when none does, and then no turn runs on it.
          gemieId: connection.answeringAgentId,
          platform,
          identityId: connection.id,
          ...(connection.oxyTaskState === 'active' && connection.oxyTaskId
            ? { taskId: connection.oxyTaskId }
            : {}),
        };
      }
    }
    if (!context) {
      res.status(401).json({ error: 'Channel account is not linked' });
      return;
    }
    req.channelContext = context;
    req.userId = context.accountId;
    // No req.user, sessionId or accessToken: remote messages cannot impersonate a foreground requester.
    next();
  } catch {
    res.status(503).json({ error: 'Channel account unavailable' });
  }
}
