import type { ChannelId } from '../lib/channels/types.js';

export interface VerifiedChannelContext {
  kind: 'bot' | 'account';
  accountId: string;
  /**
   * The gemie that answers a connected account (`kind: 'account'`, ADR 0035 as amended): it runs
   * every turn that arrives on the account, and `null` means no gemie answers it, so none runs.
   * Absent for a bot link, whose turns go to the default gemie.
   */
  gemieId?: string | null;
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
