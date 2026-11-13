import { registerChannel } from './registry.js';
import { telegramPlugin } from './plugins/telegram.js';
import { discordPlugin } from './plugins/discord.js';
import { whatsappPlugin } from './plugins/whatsapp.js';
import { slackPlugin } from './plugins/slack.js';

export function initChannels() {
  registerChannel(telegramPlugin);
  registerChannel(discordPlugin);
  registerChannel(whatsappPlugin);
  registerChannel(slackPlugin);
}

export * from './types.js';
export * from './registry.js';
export * from './outbound.js';
