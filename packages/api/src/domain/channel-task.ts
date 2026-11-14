/**
 * A channel's Oxy task: the durable authority a person grants for what arrives on a channel of
 * theirs — a connected account's answering gemie, a system bot link's assistant, a gemie bot's
 * person's own turns (ADR 0035, ADR 0037). It lasts as long as Oxy says (`oxy_task_expires_at`,
 * what Oxy answered when it was minted) and only the person's present session can mint another,
 * so it is renewed the way every standing authority is: silently, whenever the person is in the
 * app inside the renewal window, and with a one-tap notice when they have not been
 * (`lib/channel-task-authority.ts`, `docs/requester-authority.md`).
 */

const DAY_MS = 24 * 60 * 60_000;

/** A present person's session renews a task this long before it lapses, without asking. */
export const CHANNEL_TASK_RENEW_WITHIN_MS = 30 * DAY_MS;

/** A task still not renewed this long before it lapses is told to its person, once. */
export const CHANNEL_TASK_NOTICE_WITHIN_MS = 7 * DAY_MS;

/** What a binding holds of its task. */
export interface ChannelTaskHold {
  readonly oxyTaskId: string | null;
  readonly oxyTaskState: 'active' | 'reauth_required';
  /** `null` while none is held, or for a task minted before its expiry was stored and undated. */
  readonly oxyTaskExpiresAt: Date | null;
}

/**
 * The task a channel turn acts with, or `undefined` when the binding holds none, or one known to
 * be dead: Oxy refused it, or it is past the expiry Oxy gave it. An undated task is handed out
 * (Oxy still decides); a present session renews it on the person's next visit.
 */
export function liveChannelTaskId(
  hold: ChannelTaskHold,
  now: Date = new Date(),
): string | undefined {
  if (!hold.oxyTaskId || hold.oxyTaskState !== 'active') return undefined;
  if (hold.oxyTaskExpiresAt && hold.oxyTaskExpiresAt.getTime() <= now.getTime()) return undefined;
  return hold.oxyTaskId;
}

/** Whether a present person's session renews it now: lapsed, undated, or inside the window. */
export function channelTaskDueForRenewal(hold: ChannelTaskHold, now: Date = new Date()): boolean {
  if (liveChannelTaskId(hold, now) === undefined) return true;
  return (
    hold.oxyTaskExpiresAt === null ||
    hold.oxyTaskExpiresAt.getTime() - now.getTime() <= CHANNEL_TASK_RENEW_WITHIN_MS
  );
}
