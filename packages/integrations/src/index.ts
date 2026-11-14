import 'dotenv/config';
import express from 'express';
import { oxyTrustProxy, startEcosystemTraffic } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { OXY_SOURCE_REGION_HEADER } from '@oxy.so/telemetry';
import { Server as WebSocketServer } from 'ws';
import http from 'http';
import { closePostgres, connectPostgres } from './db';
import type { AccountGateway } from './accounts/gateway';
import type { BotAdapter } from './bots/types';
import { setWss, type SessionWebSocket } from './realtime/wss-global';
import { maySubscribe } from './realtime/subscription-auth';
import {
  requireAliaApi,
  requireAccountContext,
  internalAccount,
  authorizeInternalUpgrade,
} from './shared/internal-auth';
import { createLogger } from './shared/logger';
import { runShutdownSteps } from './shared/shutdown';

const logger = createLogger('Integrations');

// Node lower-cases incoming header names.
const SOURCE_REGION_HEADER = OXY_SOURCE_REGION_HEADER.toLowerCase();

const PORT = Number(process.env.PORT) || 3005;
const INTERNAL_PORT = 3005; // Must match the ECS container health-check port.
const DATABASE_URL = process.env.DATABASE_URL;
const APP_NAME = 'integrations';

if (!DATABASE_URL) {
  logger.error('DATABASE_URL is required');
  process.exit(1);
}
const POSTGRES_URL: string = DATABASE_URL;

let activityReady = false;
const activity = startEcosystemTraffic({
  service: 'alia-integrations',
  ready: () => activityReady,
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});
const accountGateways: AccountGateway[] = [];
const botAdapters: BotAdapter[] = [];

/** Everything that starts after the server listens and stops on shutdown, by name. */
function lifecycles(): Array<{
  name: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}> {
  return [
    ...accountGateways.map((gateway) => ({
      name: gateway.platform,
      initialize: () => gateway.initialize(),
      shutdown: () => gateway.shutdown(),
    })),
    ...botAdapters,
    {
      name: 'telegram',
      initialize: async () => {
        const { startTelegram } = await import('./telegram');
        await startTelegram();
      },
      shutdown: async () => {
        const { stopTelegram } = await import('./telegram');
        await stopTelegram();
      },
    },
  ];
}

async function loadAdapters(): Promise<void> {
  // Account gateways: the WhatsApp and Telegram accounts people link to their gemies (ADR 0035).
  // A platform that cannot run here is not mounted, so the API never offers it.
  if (process.env.WHATSAPP_ENABLED !== 'false') {
    const { whatsAppGateway } = await import('./accounts/whatsapp/gateway');
    accountGateways.push(whatsAppGateway);
  }
  // Telegram accounts are Telegram Business connections to the shared bot (ADR 0037).
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const { telegramBusinessGateway } = await import('./telegram/business/gateway');
    accountGateways.push(telegramBusinessGateway);
  }

  // Bot Adapters — system bots (active sending + external user interaction)

  // Discord Bot
  if (process.env.DISCORD_BOT_ENABLED !== 'false' && process.env.DISCORD_BOT_TOKEN) {
    const { DiscordBotAdapter } = await import('./bots/discord-bot/adapter');
    botAdapters.push(new DiscordBotAdapter());
  }
}

const ADAPTER_INIT_TIMEOUT_MS = 30_000;

async function initAdapterWithTimeout(adapter: {
  name: string;
  initialize(): Promise<void>;
}): Promise<void> {
  await Promise.race([
    adapter.initialize(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out after ${ADAPTER_INIT_TIMEOUT_MS / 1000}s`)),
        ADAPTER_INIT_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function main() {
  // Build the pool before an adapter can query it. A MALFORMED DATABASE_URL
  // throws here and takes the boot down; an unreachable server does not —
  // postgres.js opens a socket lazily, so that surfaces on the first query.
  connectPostgres(POSTGRES_URL);
  logger.info('Postgres pool ready');

  // Load adapter instances (constructors only — no external calls)
  await loadAdapters();

  // Express app
  const app = express();
  // The real client behind the ALB (and Cloudflare, when proxied); see
  // `oxyTrustProxy` in @oxy.so/core.
  app.set('trust proxy', oxyTrustProxy);
  app.use(activity.observeHttp);
  // A gemie bot's profile carries its avatar as a JPEG (`telegram/gemie-bots.ts`).
  app.use(express.json({ limit: '2mb' }));

  // Health check
  app.get('/health', async (_req, res) => {
    let mcpSessions: import('./mcp/manager').McpSessionSummary[] = [];
    try {
      const { listSessions } = await import('./mcp/manager');
      mcpSessions = listSessions();
    } catch (err) {
      // MCP session summary is best-effort — a health check must still respond.
      logger.debug('Failed to list MCP sessions for health check:', err);
    }

    res.json({
      status: 'ok',
      service: APP_NAME,
      uptime: process.uptime(),
      accounts: accountGateways.map((gateway) => gateway.platform),
      bots: botAdapters.map((a) => a.name),
      mcpServers: mcpSessions.length,
    });
  });

  /** Scope terminal/browser resources to the verified API operation account. */
  const requireSessionOwner = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    const ownerUserId = internalAccount(req);
    if (!ownerUserId) {
      res.status(401).json({ error: 'User context required' });
      return;
    }
    // Inside the mounted router, req.path is `/session/<sessionId>/<action>`.
    const match = req.path.match(/^\/session\/([^/]+)\//);
    const sessionId = match ? decodeURIComponent(match[1]) : '';
    if (!sessionId.startsWith(`${ownerUserId}:`)) {
      res.status(403).json({ error: 'Session does not belong to user' });
      return;
    }
    next();
  };

  // The platforms this deployment can link, which the API offers (and nothing else).
  app.get('/accounts/platforms', requireAliaApi, requireAccountContext, (_req, res) => {
    res.json({ platforms: accountGateways.map((gateway) => gateway.platform) });
  });

  // One router for every platform, under /accounts/<platform>.
  const { gatewayRouter } = await import('./accounts/gateway-router');
  for (const gateway of accountGateways) {
    app.use(
      `/accounts/${gateway.platform}`,
      requireAliaApi,
      requireAccountContext,
      gatewayRouter(gateway),
    );
    logger.info(`Mounted account routes: /accounts/${gateway.platform}`);
  }

  // Telegram (ADR 0037): the API relays every bot's webhook here, and manages gemies' own bots.
  const { telegramRoutes } = await import('./telegram');
  const telegram = telegramRoutes();
  app.use('/telegram/updates', requireAliaApi, telegram.updates);
  app.use('/telegram/bots', requireAliaApi, telegram.bots);
  logger.info('Mounted routes: /telegram');

  // MCP server management routes
  const { mcpRouter, mcpCatalogueRouter } = await import('./mcp/routes');
  app.use('/mcp', requireAliaApi, requireAccountContext, mcpRouter);
  // The connectors store's health check acts for no account.
  app.use('/mcp-catalogue', requireAliaApi, mcpCatalogueRouter);
  logger.info('Mounted routes: /mcp, /mcp-catalogue');

  // Browser routes (lazy-loaded)
  try {
    const { browserRouter } = await import('./routes/browser');
    app.use('/browser', requireAliaApi, requireAccountContext, requireSessionOwner, browserRouter);
    logger.info('Mounted routes: /browser');
  } catch (err) {
    logger.info('Browser routes not available');
    logger.debug('Browser route load error:', err);
  }

  // Terminal routes (lazy-loaded)
  try {
    const { terminalRouter } = await import('./routes/terminal');
    app.use(
      '/terminal',
      requireAliaApi,
      requireAccountContext,
      requireSessionOwner,
      terminalRouter,
    );
    logger.info('Mounted routes: /terminal');
  } catch (err) {
    logger.info('Terminal routes not available');
    logger.debug('Terminal route load error:', err);
  }

  // HTTP + WebSocket server
  const server = http.createServer(app);

  // WebSocket for real-time streaming (terminal output, browser screenshots)
  const wss = new WebSocketServer({ server, path: '/ws' });
  // The upgrade verifies the same workload and account context as HTTP.
  wss.on('connection', async (ws, request) => {
    const ownerUserId = await authorizeInternalUpgrade(request.headers);
    if (!ownerUserId) {
      logger.debug('Rejected an unauthenticated internal WebSocket upgrade');
      // 1008 is "policy violation" — the honest code, and it reaches the client
      // as a close reason rather than as a connection that silently never
      // receives anything.
      ws.close(1008, 'Internal authentication required');
      return;
    }

    activity.observeWebSocket(ws, {
      activityType: 'communication',
      getPeer: () => ({
        service: 'alia',
        region:
          typeof request.headers[SOURCE_REGION_HEADER] === 'string'
            ? request.headers[SOURCE_REGION_HEADER]
            : undefined,
      }),
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle subscribe/unsubscribe to session streams
        if (msg.type === 'subscribe') {
          if (!maySubscribe(ownerUserId, msg.sessionId)) {
            logger.debug('Refused a subscription outside the connection owner namespace');
            return;
          }
          (ws as SessionWebSocket).sessionId = msg.sessionId;
        }
      } catch (err) {
        // Malformed client frame — ignore it rather than tearing down the socket.
        logger.debug('Discarded malformed WebSocket message:', err);
      }
    });
  });

  // Make WSS available for terminal/browser managers
  setWss(wss);

  // Start HTTP server FIRST so health checks pass during adapter initialization
  await new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      activityReady = true;
      logger.info(`Running on port ${PORT}`);
      resolve();
    });
  });

  // If an operator overrides PORT, retain the canonical internal health port so
  // the ECS container health check remains reachable.
  if (PORT !== INTERNAL_PORT) {
    const healthServer = http.createServer(app);
    healthServer.listen(INTERNAL_PORT, () => {
      logger.info(`Health/internal on port ${INTERNAL_PORT}`);
    });
  }

  // Initialize all adapters AFTER the server is listening (with timeouts)
  const allAdapters = lifecycles();
  for (const adapter of allAdapters) {
    try {
      await initAdapterWithTimeout(adapter);
      logger.info(`${adapter.name} adapter initialized`);
    } catch (err) {
      logger.error(`Failed to initialize ${adapter.name}:`, err);
    }
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  activityReady = false;
  logger.info(`Received ${signal}, shutting down...`);
  const allAdapters = lifecycles();
  const failed = await runShutdownSteps(
    [
      {
        name: 'MCP servers',
        run: async () => {
          const { shutdownAll: shutdownMcp } = await import('./mcp/manager');
          await shutdownMcp();
        },
      },
      ...allAdapters.map((adapter) => ({ name: adapter.name, run: () => adapter.shutdown() })),
      { name: 'platform activity', run: async () => activity.stop() },
      { name: 'Postgres pool', run: () => closePostgres() },
    ],
    logger,
  );
  if (failed.length > 0) {
    logger.error(`Shutdown finished with failures in: ${failed.join(', ')}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
