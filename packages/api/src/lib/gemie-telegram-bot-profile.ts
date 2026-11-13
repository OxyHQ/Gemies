/**
 * A gemie's own Telegram bot shows its gemie, by itself (ADR 0037): its name, its description and
 * tagline, and a photo of its character in its colour. Nobody presses anything.
 *
 * Every write that changes what the bot mirrors marks the bot behind (`markGemieBotProfileBehind`,
 * from `applyAgentEdit`). The sync waits a short debounce, so an editor autosaving as someone types
 * becomes one update, then runs at once on this instance; the run reaper's minute sweep picks up
 * whatever an instance that died left behind. It is durable: a deploy or a restart loses nothing.
 *
 * A failure (Telegram down, a rate limit, a revoked token) is kept for the editor to show, and
 * retried with a backoff, or after Telegram's own `retry_after`. The photo is drawn on the server
 * (the integrations process, from Bloom's `renderAgentAvatarPicture`) and uploaded only when the
 * look or the colour changed, because Telegram rate-limits profile updates.
 */

import { createHash } from 'node:crypto';
import { findAgentById } from '../db/agents/agentRepository.js';
import { getDb } from '../db/index.js';
import {
  type ClaimedProfileSync,
  claimDueGemieBotProfile,
  deferGemieBotProfile,
  markGemieBotProfileBehind,
  settleGemieBotProfile,
} from '../db/integrations/gemieBotRepository.js';
import { agentPromptName, attachAgentIdentity } from './agent-identity.js';
import {
  type TelegramBotProfile,
  TelegramBotSetupError,
  updateTelegramBotProfile,
} from './gemie-telegram-bot-setup.js';
import { log } from './logger.js';

/** How long a change waits for the next one before the bot is updated. */
export const PROFILE_DEBOUNCE_MS = 3_000;
/** How long one attempt holds a bot before another instance may take it. */
const CLAIM_LEASE_MS = 2 * 60_000;
/** Backoff after a failure: 15 s, doubling, at most an hour. */
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 60 * 60_000;
/** At most this many bots per run, so one run never holds the sweep for long. */
const BATCH = 20;

export function profileBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts), BACKOFF_MAX_MS);
}

/** What the bot's photo is drawn from: its look and its colour. A changed key is a new photo. */
export function photoKeyOf(character: unknown, color: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([character, color]))
    .digest('hex')
    .slice(0, 32);
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Run the sync on this instance once `delayMs` passed, folding every earlier request into it. */
function syncSoon(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncDueGemieBotProfiles().catch((err: unknown) =>
      log.channels.error({ err }, 'Gemie bot profile sync failed'),
    );
  }, delayMs);
  timer.unref?.();
}

/**
 * The gemie changed something its bot shows: the bot is behind until the sync gives it the change.
 * Best effort for the caller: the change is already saved, and a missed mark is not a lost one for
 * long (an edit marks again; the editor's retry marks too).
 */
export async function gemieProfileChanged(agentId: string): Promise<void> {
  try {
    if (await markGemieBotProfileBehind(getDb(), agentId, PROFILE_DEBOUNCE_MS)) {
      syncSoon(PROFILE_DEBOUNCE_MS + 100);
    }
  } catch (err: unknown) {
    log.channels.warn({ err, agentId }, 'Could not mark a gemie bot profile behind');
  }
}

/** The editor's retry, or a bot just connected: due now. */
export async function syncGemieBotProfileNow(agentId: string): Promise<void> {
  if (await markGemieBotProfileBehind(getDb(), agentId, 0)) syncSoon(0);
}

/** What the bot should show of the gemie, or null when the gemie is gone. */
async function profileOf(
  agentId: string,
  previousPhotoKey: string | null,
): Promise<{ profile: TelegramBotProfile; photoKey: string } | null> {
  const found = await findAgentById(getDb(), agentId);
  if (!found) return null;
  const agent = await attachAgentIdentity(found);
  // Oxy did not answer for the account: retried, rather than writing "Agent" over the bot's name.
  if (agent.name === null) throw new Error('Oxy could not be asked for the gemie’s name');
  const photoKey = photoKeyOf(agent.character, agent.color);
  return {
    photoKey,
    profile: {
      name: agentPromptName(agent),
      description: agent.description || agent.tagline,
      shortDescription: agent.tagline || agent.description,
      photo:
        photoKey === previousPhotoKey ? null : { character: agent.character, color: agent.color },
    },
  };
}

async function syncOne(claim: ClaimedProfileSync): Promise<void> {
  const db = getDb();
  let photoKey = claim.photoKey;
  try {
    const wanted = await profileOf(claim.agentId, claim.photoKey);
    if (!wanted) {
      await settleGemieBotProfile(db, claim, claim.photoKey, PROFILE_DEBOUNCE_MS);
      return;
    }
    const result = await updateTelegramBotProfile(claim.token, wanted.profile);
    if (wanted.profile.photo && result.profile.photo) photoKey = wanted.photoKey;
    const failed = (['name', 'description', 'photo'] as const)
      .filter((part) => part !== 'photo' || wanted.profile.photo !== null)
      .filter((part) => !result.profile[part]);
    if (failed.length === 0) {
      await settleGemieBotProfile(db, claim, photoKey, PROFILE_DEBOUNCE_MS);
      return;
    }
    const retryAfterMs = (result.retryAfter ?? 0) * 1000;
    await deferGemieBotProfile(db, claim, {
      error: result.error ?? `Telegram did not take the bot’s ${failed.join(', ')}`,
      retryAt: new Date(Date.now() + Math.max(retryAfterMs, profileBackoffMs(claim.attempts))),
      photoKey,
    });
  } catch (err: unknown) {
    const error =
      err instanceof TelegramBotSetupError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'The bot could not be updated';
    log.channels.warn({ err, botId: claim.id }, 'A gemie bot profile sync failed');
    await deferGemieBotProfile(db, claim, {
      error,
      retryAt: new Date(Date.now() + profileBackoffMs(claim.attempts)),
      photoKey,
    });
  }
}

let running = false;

/** Give every bot that is behind its gemie's profile. Safe on every instance and every tick. */
export async function syncDueGemieBotProfiles(): Promise<number> {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    while (done < BATCH) {
      const claim = await claimDueGemieBotProfile(getDb(), CLAIM_LEASE_MS);
      if (!claim) break;
      // A token that cannot be read is kept as the bot's failure, and the others go on.
      if (claim !== 'unreadable') await syncOne(claim);
      done += 1;
    }
  } finally {
    running = false;
  }
  return done;
}
