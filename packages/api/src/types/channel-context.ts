import type { ChannelId } from '../lib/channels/types.js';

export interface VerifiedChannelContext {
  /**
   * `bot`: a person linked to a system bot (Discord). `account`: a message that arrived on a
   * person's connected account, from one of their contacts (ADR 0035). `gemie_bot`: the person who
   * connected a gemie's own Telegram bot, writing in private from the Telegram account they linked
   * to it (ADR 0037, amendment) — the person themselves, present in the turn.
   */
  kind: 'bot' | 'account' | 'gemie_bot';
  accountId: string;
  /**
   * The gemie that runs the turn: a connected account's answering gemie (`account`, ADR 0035 as
   * amended; `null` when none answers it, so none runs), or the gemie whose bot it is
   * (`gemie_bot`). Absent for a system bot link, whose turns go to the default gemie.
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
