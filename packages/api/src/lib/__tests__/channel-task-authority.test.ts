/**
 * The owning helper of channels' Oxy tasks (`channel-task-authority.ts`): a present person's
 * session renews what is due, with the actor each kind of channel grants; the sweep tells each
 * person once, in the app with a one-tap link and on the channel itself; a notice that could not
 * be sent is claimed again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelBinding } from '../../db/integrations/channelTaskRepository.js';

const H = vi.hoisted(() => ({
  bindings: [] as unknown[],
  claimed: [] as unknown[],
  bind: vi.fn(),
  lapse: vi.fn(),
  release: vi.fn(),
  minted: [] as Array<Record<string, unknown>>,
  revoked: [] as Array<string | null>,
  grantable: vi.fn(),
  actor: vi.fn(),
  notify: vi.fn(),
  accountNotice: vi.fn(),
  discord: vi.fn(),
  relay: vi.fn(),
  connections: vi.fn(),
  gemies: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/integrations/channelTaskRepository.js', () => ({
  listPersonChannelBindings: async () => H.bindings,
  claimChannelTaskNotices: async () => H.claimed,
  bindChannelTask: H.bind,
  lapseExpiredChannelTasks: H.lapse,
  releaseChannelTaskNotice: H.release,
}));
vi.mock('../../db/integrations/connectedAccountRepository.js', () => ({
  findPersonAccount: async (_db: unknown, id: string) => ({ id, platform: 'telegram' }),
}));
vi.mock('../oxy-task-authority.js', () => ({
  // `bindOxyTask`'s contract (its own suite proves it): mint, write, release after.
  bindOxyTask: async (
    input: Record<string, unknown>,
    write: (task: { id: string; expiresAt: Date }) => Promise<{ replaced: string | null } | null>,
  ) => {
    H.minted.push(input);
    const task = { id: `new-${H.minted.length}`, expiresAt: new Date('2027-11-14') };
    const written = await write(task);
    H.revoked.push(written ? written.replaced : task.id);
    return written ? task : null;
  },
}));
vi.mock('../agent-account.js', () => ({
  loadGrantableGemie: H.grantable,
  loadAgentForActor: H.actor,
}));
vi.mock('../memory/user-memory-service.js', () => ({ messageLanguageOf: async () => 'es' }));
vi.mock('../notification-service.js', () => ({ sendNotification: H.notify }));
vi.mock('../connected-accounts.js', () => ({ notifyAccountPerson: H.accountNotice }));
vi.mock('../channels/outbound.js', () => ({ sendChannelMessage: H.discord }));
vi.mock('../gemie-telegram-bot-setup.js', () => ({ relayToGemieBotChat: H.relay }));
vi.mock('../realtime/account.js', () => ({
  publishConnectionsChanged: H.connections,
  publishGemieChanged: H.gemies,
}));
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { log: { channels: child } };
});

const { renewDueChannelTasks, sweepChannelTasks, channelTaskNotice, REAUTHORIZE_PATH } =
  await import('../channel-task-authority.js');

const NOW = new Date('2026-11-14T12:00:00Z');
const DAY = 86_400_000;
const PERSON = { accountId: 'person-1', accessToken: 'PERSON-TOKEN' };
const GEMIE = { reach: 'grants', identity: { source: 'oxy', oxyAccountId: 'gemie-account' } };

function binding(over: Partial<ChannelBinding>): ChannelBinding {
  return {
    kind: 'account',
    id: 'account-1',
    personAccountId: 'person-1',
    platform: 'telegram',
    gemieId: 'gemie-1',
    personChat: null,
    oxyTaskId: 'old-task',
    oxyTaskState: 'active',
    oxyTaskExpiresAt: new Date(NOW.getTime() + 200 * DAY),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  H.minted = [];
  H.revoked = [];
  H.bindings = [];
  H.claimed = [];
  H.bind.mockResolvedValue(true);
  H.lapse.mockResolvedValue(0);
  H.release.mockResolvedValue(undefined);
  H.grantable.mockResolvedValue({ ok: true, agent: GEMIE });
  H.actor.mockResolvedValue({ ok: true, agent: GEMIE });
  H.notify.mockResolvedValue({});
  H.accountNotice.mockResolvedValue({ messageId: 'm' });
  H.discord.mockResolvedValue([{ channel: 'discord', ok: true }]);
  H.relay.mockResolvedValue(undefined);
  H.connections.mockResolvedValue(undefined);
  H.gemies.mockResolvedValue(undefined);
});

describe('renewing with the person present', () => {
  it('renews only what is due: lapsed, undated, or inside the window', async () => {
    H.bindings = [
      binding({ id: 'far' }),
      binding({ id: 'soon', oxyTaskExpiresAt: new Date(NOW.getTime() + 20 * DAY) }),
      binding({ id: 'refused', oxyTaskState: 'reauth_required' }),
      binding({ id: 'expired', oxyTaskExpiresAt: new Date(NOW.getTime() - DAY) }),
      binding({ id: 'undated', oxyTaskExpiresAt: null }),
      binding({ id: 'none', oxyTaskId: null, oxyTaskState: 'reauth_required' }),
    ];
    const result = await renewDueChannelTasks(PERSON, NOW);
    expect(result.renewed.map((ref) => ref.id)).toEqual([
      'soon',
      'refused',
      'expired',
      'undated',
      'none',
    ]);
    expect(result.failed).toEqual([]);
    // Each in place of the task it held, released after.
    expect(H.bind).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: 'soon', oxyTaskId: 'old-task' }),
      { id: 'new-1', expiresAt: new Date('2027-11-14') },
    );
    expect(H.revoked).toEqual(['old-task', 'old-task', 'old-task', 'old-task', null]);
    expect(H.connections).toHaveBeenCalledWith('person-1');
  });

  it('grants each kind the actor it was granted with, from the present session', async () => {
    H.bindings = [
      binding({ kind: 'account', id: 'a', oxyTaskState: 'reauth_required' }),
      binding({ kind: 'bot_link', id: 'b', gemieId: null, oxyTaskState: 'reauth_required' }),
      binding({ kind: 'gemie_bot', id: 'g', oxyTaskState: 'reauth_required' }),
    ];
    await renewDueChannelTasks(PERSON, NOW);
    expect(H.minted).toEqual([
      {
        accessToken: 'PERSON-TOKEN',
        effectiveAccountId: 'person-1',
        actor: { type: 'agent', accountId: 'gemie-account' },
        origin: { kind: 'automation', id: 'channel:a' },
      },
      expect.objectContaining({
        actor: { type: 'alia', ownerAccountId: 'person-1' },
        origin: { kind: 'automation', id: 'channel:b' },
      }),
      expect.objectContaining({ origin: { kind: 'automation', id: 'channel:g' } }),
    ]);
    // An account's gemie as one they may grant; a gemie bot's as one they may act as.
    expect(H.grantable).toHaveBeenCalledWith(
      {},
      { agentId: 'gemie-1', oxyUserId: 'person-1', accessToken: 'PERSON-TOKEN' },
    );
    expect(H.actor).toHaveBeenCalledWith(
      {},
      { agentId: 'gemie-1', oxyUserId: 'person-1', accessToken: 'PERSON-TOKEN', cache: false },
    );
    expect(H.gemies).toHaveBeenCalledWith('person-1', 'gemie-1', 'updated');
  });

  it('reports what it could not renew, and goes on with the rest', async () => {
    H.bindings = [
      binding({ id: 'not-grantable', oxyTaskState: 'reauth_required' }),
      binding({ id: 'changed', oxyTaskState: 'reauth_required' }),
      binding({ id: 'oxy-down', oxyTaskState: 'reauth_required' }),
      binding({ id: 'fine', oxyTaskState: 'reauth_required' }),
    ];
    H.grantable.mockResolvedValueOnce({ ok: false, refusal: 'not_permitted' });
    H.bind.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('oxy down'));
    const result = await renewDueChannelTasks(PERSON, NOW);
    expect(result.failed.map((ref) => ref.id)).toEqual(['not-grantable', 'changed', 'oxy-down']);
    expect(result.renewed.map((ref) => ref.id)).toEqual(['fine']);
    // A binding that changed meanwhile keeps its task: only the new one was let go.
    expect(H.revoked).toEqual(['new-1', 'old-task']);
  });

  it('never renews somebody else’s binding', async () => {
    H.bindings = [binding({ personAccountId: 'person-2', oxyTaskState: 'reauth_required' })];
    expect((await renewDueChannelTasks(PERSON, NOW)).failed).toHaveLength(1);
    expect(H.minted).toEqual([]);
  });
});

describe('the sweep', () => {
  it('lapses what is past its expiry, then tells each person once, with the one-tap page', async () => {
    H.claimed = [
      binding({ kind: 'account', id: 'a', oxyTaskState: 'reauth_required' }),
      binding({
        kind: 'bot_link',
        id: 'b',
        platform: 'discord',
        gemieId: null,
        personChat: 'dm-1',
        oxyTaskExpiresAt: new Date(NOW.getTime() + 5 * DAY),
      }),
      binding({
        kind: 'gemie_bot',
        id: 'g',
        personChat: 'telegram:1:2',
        oxyTaskState: 'reauth_required',
      }),
    ];
    await sweepChannelTasks(NOW);
    expect(H.lapse).toHaveBeenCalledWith({}, NOW);
    expect(H.notify).toHaveBeenCalledTimes(3);
    expect(H.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'person-1',
        type: 'integration_event',
        priority: 'high',
        title: 'Vuelve a autorizar Telegram',
        data: expect.objectContaining({ path: REAUTHORIZE_PATH }),
      }),
    );
    // And on the channel itself, with the link.
    expect(H.accountNotice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      'person-1',
      expect.stringContaining(`${REAUTHORIZE_PATH}`),
    );
    expect(H.discord).toHaveBeenCalledWith(
      'discord',
      'dm-1',
      expect.stringContaining('dejarán de poder usar tus apps'),
    );
    expect(H.relay).toHaveBeenCalledWith({
      agentId: 'gemie-1',
      conversationId: 'telegram:1:2',
      text: expect.stringContaining(REAUTHORIZE_PATH),
    });
    expect(H.release).not.toHaveBeenCalled();
  });

  it('claims a notice again when the app’s could not be sent; a silent channel is no reason', async () => {
    H.claimed = [binding({ id: 'a' }), binding({ id: 'b' })];
    H.notify.mockRejectedValueOnce(new Error('database blinked'));
    H.accountNotice.mockRejectedValue(new Error('gateway down'));
    await sweepChannelTasks(NOW);
    expect(H.release).toHaveBeenCalledTimes(1);
    expect(H.release).toHaveBeenCalledWith({}, expect.objectContaining({ id: 'a' }));
  });
});

describe('the notice', () => {
  it('says when it lapses while it still stands, and that it lapsed once it does not', () => {
    const soon = binding({ oxyTaskExpiresAt: new Date('2026-11-20T00:00:00Z') });
    expect(channelTaskNotice(soon, 'en', NOW)).toEqual({
      title: 'Renew Telegram',
      body: 'Replies on Telegram stop being able to use your apps on 20 November. Tap to renew it.',
    });
    expect(channelTaskNotice({ ...soon, kind: 'gemie_bot' }, 'es', NOW).title).toBe(
      'Renueva el bot de Telegram de tu gemie',
    );
    const lapsed = binding({ platform: 'whatsapp', oxyTaskState: 'reauth_required' });
    expect(channelTaskNotice(lapsed, 'en', NOW)).toEqual({
      title: 'Authorise WhatsApp again',
      body: 'Replies on WhatsApp can no longer use your apps. Tap to authorise it again.',
    });
  });
});
