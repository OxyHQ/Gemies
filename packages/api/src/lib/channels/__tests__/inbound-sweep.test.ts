import { beforeEach, describe, expect, it, vi } from 'vitest';

const claim = vi.fn();
const claimStalled = vi.fn();
const settle = vi.fn(() => Promise.resolve());
const purge = vi.fn(() => Promise.resolve());
const findBotUserById = vi.fn();
const processChannelMessage = vi.fn(() => Promise.resolve());

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/integrations/botRepository.js', () => ({ findBotUserById }));
vi.mock('../../../db/integrations/channelInboundRepository.js', () => ({
  claimChannelInbound: claim,
  claimStalledChannelInbound: claimStalled,
  settleChannelInbound: settle,
  purgeChannelInbound: purge,
}));
vi.mock('../inbound-handlers.js', () => ({ processChannelMessage }));

const { processAcceptedChannelInbound, reapStalledChannelInbound } = await import(
  '../inbound-sweep.js'
);

const message = { platformUserId: 'p', chatId: 'c', text: 'hola' };
const work = () => ({
  id: 'in-1',
  kind: 'system' as const,
  channelType: 'discord',
  botId: 'bot-1',
  botUserId: 'bu-1',
  message,
  attempts: 1,
});

describe('inbound sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findBotUserById.mockResolvedValue({ id: 'bu-1' });
  });

  it('answers a system-bot message and settles it done', async () => {
    claim.mockResolvedValue(work());
    await processAcceptedChannelInbound('in-1');
    expect(processChannelMessage).toHaveBeenCalledWith('discord', { id: 'bu-1' }, message);
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'done');
  });

  it('does nothing when another instance already holds the message', async () => {
    claim.mockResolvedValue(null);
    await processAcceptedChannelInbound('in-1');
    expect(processChannelMessage).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('settles failed, without throwing, when the handler throws', async () => {
    claim.mockResolvedValue(work());
    processChannelMessage.mockRejectedValueOnce(new Error('boom'));
    await expect(processAcceptedChannelInbound('in-1')).resolves.toBeUndefined();
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'failed');
  });

  it('fails a message whose person is gone', async () => {
    claim.mockResolvedValue(work());
    findBotUserById.mockResolvedValue(null);
    await processAcceptedChannelInbound('in-1');
    expect(processChannelMessage).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith({}, 'in-1', 'failed');
  });

  it('reaps stalled messages, answers each, and purges', async () => {
    claimStalled.mockResolvedValue([work(), { ...work(), id: 'in-2' }]);
    expect(await reapStalledChannelInbound()).toBe(2);
    expect(processChannelMessage).toHaveBeenCalledTimes(2);
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
