import type { ChannelId } from '../lib/channels/types.js';

export interface VerifiedChannelContext {
  kind: 'bot' | 'account';
  accountId: string;
  /**
   * The gemie a connected account belongs to (`kind: 'account'`, ADR 0035): it answers every turn
   * that arrives on the account. Absent for a bot link, whose turns go to the default gemie.
   */
  gemieId?: string;
  platform: string;
  identityId: string;
  taskId?: string;
}

declare global {
  // biome-ignore lint/style/noNamespace: Express request augmentation.
  namespace Express {
    interface Request {
      channelType?: ChannelId;
      channelContext?: VerifiedChannelContext;
    }
  }
}
