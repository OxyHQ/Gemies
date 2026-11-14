/**
 * The owning helper of every channel's Oxy task (`domain/channel-task.ts`): a connected account's,
 * a system bot link's and a gemie bot's person's (`db/integrations/channelTaskRepository.ts`).
 * Autonomy on a channel never lapses unseen:
 *
 *  - **Stored with its expiry.** Every channel task is minted through `bindOxyTask`, which stores
 *    the expiry Oxy answered and releases the task it replaced only after the new one is written.
 *  - **Renewed before it lapses, the way every standing authority is.** Only the person's present
 *    session can mint a task (Oxy `first-party-tasks.md`; no bearer is ever stored), so the app's
 *    silent handshake (`POST /me/channel-tasks/renew`, `useChannelTaskRenewal` in the SDK) renews
 *    every binding of theirs that is lapsed, undated or inside the renewal window, as the agents'
 *    work handshake (`POST /agents/:id/work`) renews theirs.
 *  - **Lapsed in one place.** The minute sweep marks `reauth_required` what is past Oxy's expiry;
 *    a tool call Oxy refuses for the task itself does the same (`standingTaskRefused`). Channel
 *    turns are never handed a task known to be dead (`liveChannelTaskId`).
 *  - **Told once.** When renewal needs the person — the task lapsed, or lapses within the notice
 *    window and they have not been in the app — they get one notification that reauthorises in a
 *    tap ({@link REAUTHORIZE_PATH}), and a message on the channel itself when it can still write.
 */

import { getDb } from '../db/index.js';
import {
  bindChannelTask,
  type ChannelBinding,
  type ChannelBindingRef,
  claimChannelTaskNotices,
  lapseExpiredChannelTasks,
  listPersonChannelBindings,
  releaseChannelTaskNotice,
} from '../db/integrations/channelTaskRepository.js';
import { findPersonAccount } from '../db/integrations/connectedAccountRepository.js';
import {
  CHANNEL_TASK_NOTICE_WITHIN_MS,
  channelTaskDueForRenewal,
  liveChannelTaskId,
} from '../domain/channel-task.js';
import { loadAgentForActor, loadGrantableGemie } from './agent-account.js';
import type { ChannelId } from './channels/types.js';
import { sendChannelMessage } from './channels/outbound.js';
import { notifyAccountPerson } from './connected-accounts.js';
import { relayToGemieBotChat } from './gemie-telegram-bot-setup.js';
import { oxyActorFor, personAssistantActor } from './gemie-oxy-actor.js';
import { log } from './logger.js';
import { type MessageLanguage, messageLanguageOf } from './memory/user-memory-service.js';
import { sendNotification } from './notification-service.js';
import { bindOxyTask } from './oxy-task-authority.js';
import { publishConnectionsChanged, publishGemieChanged } from './realtime/account.js';

/** The app's page that reauthorises every channel of the signed-in person in one tap. */
export const REAUTHORIZE_PATH = '/channels/reauthorize';

/** That page on the web app, for a channel to link to. */
export function reauthorizeUrl(): string {
  return `${process.env.WEB_URL || 'http://localhost:8150'}${REAUTHORIZE_PATH}`;
}

/** How many notices one sweep sends per kind of channel, at most. */
const NOTICES_PER_SWEEP = 50;

interface PresentPerson {
  readonly accountId: string;
  /** Their present Oxy session: the only thing that can mint a task. Never stored. */
  readonly accessToken: string;
}

/** The actor the binding's task names, as the person may still grant it; `null` when they may not. */
async function actorFor(binding: ChannelBinding, person: PresentPerson) {
  if (binding.gemieId === null) return personAssistantActor(person.accountId);
  const params = { agentId: binding.gemieId, oxyUserId: person.accountId };
  // The checks that granted it: an account's gemie is one the person may grant
  // (`routes/me-accounts.ts`); a gemie bot's, one they may act as (`routes/agents/telegram-bot.ts`).
  const loaded =
    binding.kind === 'account'
      ? await loadGrantableGemie(getDb(), { ...params, accessToken: person.accessToken })
      : await loadAgentForActor(getDb(), {
          ...params,
          accessToken: person.accessToken,
          cache: false,
        });
  return loaded.ok ? oxyActorFor(loaded.agent, person.accountId) : null;
}

/** Renew one binding with the person's present session. False when it could not be. */
export async function renewChannelBinding(
  binding: ChannelBinding,
  person: PresentPerson,
): Promise<boolean> {
  if (binding.personAccountId !== person.accountId) return false;
  const actor = await actorFor(binding, person);
  if (!actor) return false;
  const task = await bindOxyTask(
    {
      accessToken: person.accessToken,
      effectiveAccountId: person.accountId,
      actor,
      origin: { kind: 'automation', id: `channel:${binding.id}` },
    },
    async (minted) =>
      (await bindChannelTask(getDb(), binding, minted)) ? { replaced: binding.oxyTaskId } : null,
  );
  return task !== null;
}

/**
 * Renew every channel binding of the present person that is due: lapsed, undated, or lapsing
 * inside the renewal window. What was renewed and what could not be; one failing never stops the
 * rest.
 */
export async function renewDueChannelTasks(
  person: PresentPerson,
  now: Date = new Date(),
): Promise<{ renewed: ChannelBindingRef[]; failed: ChannelBindingRef[] }> {
  const due = (await listPersonChannelBindings(getDb(), person.accountId)).filter((binding) =>
    channelTaskDueForRenewal(binding, now),
  );
  const renewed: ChannelBindingRef[] = [];
  const failed: ChannelBindingRef[] = [];
  for (const binding of due) {
    const ref = { kind: binding.kind, id: binding.id };
    const ok = await renewChannelBinding(binding, person).catch((err: unknown) => {
      log.channels.warn(
        { err, kind: binding.kind, id: binding.id },
        'A channel task did not renew',
      );
      return false;
    });
    (ok ? renewed : failed).push(ref);
    if (ok && binding.kind === 'gemie_bot' && binding.gemieId) {
      void publishGemieChanged(person.accountId, binding.gemieId, 'updated').catch(() => undefined);
    }
  }
  if (renewed.some((ref) => ref.kind === 'account')) {
    void publishConnectionsChanged(person.accountId).catch(() => undefined);
  }
  return { renewed, failed };
}

/** How a platform is written. */
const PLATFORM_NAMES: ReadonlyMap<string, string> = new Map([
  ['whatsapp', 'WhatsApp'],
  ['telegram', 'Telegram'],
  ['discord', 'Discord'],
]);

/** The notice, in the person's language: what the channel is, and what one tap does. */
export function channelTaskNotice(
  binding: Pick<
    ChannelBinding,
    'kind' | 'platform' | 'oxyTaskId' | 'oxyTaskState' | 'oxyTaskExpiresAt'
  >,
  language: MessageLanguage,
  now: Date = new Date(),
): { title: string; body: string } {
  const platform =
    PLATFORM_NAMES.get(binding.platform) ??
    binding.platform.charAt(0).toUpperCase() + binding.platform.slice(1);
  const es = language === 'es';
  const channel =
    binding.kind === 'gemie_bot'
      ? es
        ? 'el bot de Telegram de tu gemie'
        : 'your gemie’s Telegram bot'
      : platform;
  const lapsesOn = liveChannelTaskId(binding, now) ? binding.oxyTaskExpiresAt : null;
  if (lapsesOn) {
    const date = lapsesOn.toLocaleDateString(es ? 'es-ES' : 'en-GB', {
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });
    return es
      ? {
          title: `Renueva ${channel}`,
          body: `Las respuestas en ${channel} dejarán de poder usar tus apps el ${date}. Tócalo para renovarlo.`,
        }
      : {
          title: `Renew ${channel}`,
          body: `Replies on ${channel} stop being able to use your apps on ${date}. Tap to renew it.`,
        };
  }
  return es
    ? {
        title: `Vuelve a autorizar ${channel}`,
        body: `Las respuestas en ${channel} ya no pueden usar tus apps. Tócalo para autorizarlo de nuevo.`,
      }
    : {
        title: `Authorise ${channel} again`,
        body: `Replies on ${channel} can no longer use your apps. Tap to authorise it again.`,
      };
}

/** Write the notice on the channel itself, where it still can. True when it was written. */
async function writeOnChannel(binding: ChannelBinding, text: string): Promise<boolean> {
  switch (binding.kind) {
    case 'account': {
      const account = await findPersonAccount(getDb(), binding.id, binding.personAccountId);
      if (!account) return false;
      await notifyAccountPerson(account, binding.personAccountId, text);
      return true;
    }
    case 'bot_link': {
      if (!binding.personChat) return false;
      const results = await sendChannelMessage(
        binding.platform as ChannelId,
        binding.personChat,
        text,
      );
      return results.every((result) => result.ok);
    }
    case 'gemie_bot':
      if (!binding.personChat || !binding.gemieId) return false;
      await relayToGemieBotChat({
        agentId: binding.gemieId,
        conversationId: binding.personChat,
        text,
      });
      return true;
  }
}

/** Tell the person once: in the app, with the one-tap link, and on the channel when it can. */
async function tellPerson(binding: ChannelBinding, now: Date): Promise<void> {
  const notice = channelTaskNotice(binding, await messageLanguageOf(binding.personAccountId), now);
  await sendNotification({
    userId: binding.personAccountId,
    type: 'integration_event',
    title: notice.title,
    body: notice.body,
    priority: 'high',
    data: { path: REAUTHORIZE_PATH, channel: binding.kind, platform: binding.platform },
  });
  await writeOnChannel(binding, `${notice.body}\n${reauthorizeUrl()}`).catch((err: unknown) =>
    // The app's notice stands; a channel that cannot write any more is one reason it was needed.
    log.channels.warn(
      { err, kind: binding.kind },
      'A channel task notice did not reach the channel',
    ),
  );
}

/**
 * The minute sweep (`agent/run-reaper.ts`): lapse every task past Oxy's expiry, then tell each
 * person whose channel needs them, once. Safe on every instance at once: each notice is claimed by
 * one conditional write, and released for the next sweep if the app's notice could not be sent.
 */
export async function sweepChannelTasks(now: Date = new Date()): Promise<void> {
  const db = getDb();
  const lapsed = await lapseExpiredChannelTasks(db, now);
  if (lapsed > 0) log.channels.info({ lapsed }, 'Channel tasks lapsed; their people are told');
  const notices = await claimChannelTaskNotices(db, {
    now,
    noticeBefore: new Date(now.getTime() + CHANNEL_TASK_NOTICE_WITHIN_MS),
    limit: NOTICES_PER_SWEEP,
  });
  for (const binding of notices) {
    try {
      await tellPerson(binding, now);
    } catch (err: unknown) {
      log.channels.warn({ err, kind: binding.kind }, 'A channel task notice will be sent again');
      await releaseChannelTaskNotice(db, binding).catch(() => undefined);
    }
  }
}
