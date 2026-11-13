/**
 * The updates Telegram delivered, kept from acceptance until they are handled (`telegram_updates`).
 *
 * The webhook writes an update here and only then acknowledges it, because Telegram never
 * redelivers an acknowledged update. It is handled right after, and a row a dead process left
 * behind (or one whose handling failed) is picked up by the sweep, at startup and every minute,
 * until it succeeds or runs out of attempts. Deploys and restarts lose nothing.
 */

import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { telegramUpdates } from '../db/schema';
import { createLogger } from '../shared/logger';
import type { TelegramUpdate } from './types';

const logger = createLogger('telegram/inbox');

/** How many times an update is tried before it is given up as failed. */
const MAX_ATTEMPTS = 5;
/** A claim older than this belongs to a process that died, and may be taken over. */
const STALE_CLAIM_MS = 5 * 60_000;
/** A row this old that was never claimed was accepted by a process that died before handling it. */
const UNCLAIMED_GRACE_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;

export type UpdateHandler = (botId: string, update: TelegramUpdate) => Promise<void>;

/** Store an update before it is acknowledged. False when it was already accepted (a redelivery). */
export async function acceptUpdate(botId: string, update: TelegramUpdate): Promise<boolean> {
  const rows = await getDb()
    .insert(telegramUpdates)
    .values({
      botId,
      updateId: update.update_id,
      payload: update as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ updateId: telegramUpdates.updateId });
  return rows.length > 0;
}

/** Take an update to handle: one never claimed, or one whose claim went stale. */
async function claim(botId: string, updateId: number): Promise<TelegramUpdate | null> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const [row] = await getDb()
    .update(telegramUpdates)
    .set({ status: 'processing', attempts: sql`${telegramUpdates.attempts} + 1` })
    .where(
      and(
        eq(telegramUpdates.botId, botId),
        eq(telegramUpdates.updateId, updateId),
        lt(telegramUpdates.attempts, MAX_ATTEMPTS),
        or(
          eq(telegramUpdates.status, 'received'),
          and(eq(telegramUpdates.status, 'processing'), lt(telegramUpdates.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning({ payload: telegramUpdates.payload });
  return (row?.payload as TelegramUpdate | null | undefined) ?? null;
}

/** Settle an update, forgetting its content. */
async function settle(botId: string, updateId: number, status: 'done' | 'failed' | 'received') {
  await getDb()
    .update(telegramUpdates)
    .set({ status, ...(status === 'received' ? {} : { payload: null }) })
    .where(and(eq(telegramUpdates.botId, botId), eq(telegramUpdates.updateId, updateId)));
}

/**
 * Handle one accepted update: claimed, so two processes never both answer it, and settled. A
 * failure leaves it `received` for the sweep, and `failed` once it has used every attempt.
 */
export async function processUpdate(
  botId: string,
  updateId: number,
  handle: UpdateHandler,
): Promise<void> {
  const update = await claim(botId, updateId);
  if (!update) return;
  try {
    await handle(botId, update);
    await settle(botId, updateId, 'done');
  } catch (error: unknown) {
    const [row] = await getDb()
      .select({ attempts: telegramUpdates.attempts })
      .from(telegramUpdates)
      .where(and(eq(telegramUpdates.botId, botId), eq(telegramUpdates.updateId, updateId)));
    const exhausted = (row?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
    logger.error(
      `Update ${updateId} of bot ${botId} failed${exhausted ? ' for the last time' : ''}:`,
      error,
    );
    await settle(botId, updateId, exhausted ? 'failed' : 'received');
  }
}

/** Handle every update a previous process or attempt left unfinished. */
export async function sweepUpdates(handle: UpdateHandler): Promise<void> {
  const now = Date.now();
  const pending = await getDb()
    .select({ botId: telegramUpdates.botId, updateId: telegramUpdates.updateId })
    .from(telegramUpdates)
    .where(
      and(
        inArray(telegramUpdates.status, ['received', 'processing']),
        lt(telegramUpdates.attempts, MAX_ATTEMPTS),
        or(
          and(
            eq(telegramUpdates.status, 'received'),
            lt(telegramUpdates.updatedAt, new Date(now - UNCLAIMED_GRACE_MS)),
          ),
          lt(telegramUpdates.updatedAt, new Date(now - STALE_CLAIM_MS)),
        ),
      ),
    )
    .orderBy(asc(telegramUpdates.updatedAt))
    .limit(100);
  for (const row of pending) await processUpdate(row.botId, row.updateId, handle);
}

/** Forget settled updates older than a day: they hold nothing but their identity. */
async function pruneSettled(): Promise<void> {
  await getDb()
    .delete(telegramUpdates)
    .where(
      and(
        inArray(telegramUpdates.status, ['done', 'failed']),
        lt(telegramUpdates.updatedAt, new Date(Date.now() - 24 * 60 * 60_000)),
      ),
    );
}

/** Sweep now and every minute until the returned stop is called. */
export function startSweeping(handle: UpdateHandler): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepUpdates(handle);
      await pruneSettled();
    } catch (error: unknown) {
      logger.error('Sweep failed:', error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
