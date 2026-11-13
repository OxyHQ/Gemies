import { RiTelegramFill } from '@oxy.so/bloom/icons/RiTelegramFill';
import { RiWhatsappFill } from '@oxy.so/bloom/icons/RiWhatsappFill';
import type { Translate } from '../../lib/copy';
import {
  GEMIE_ACCOUNT_STATUSES,
  type ConnectedAccount,
  type GemieAccountPlatform,
} from '../../runtime/connected-accounts';

/** The strings of the connected-accounts screens. */
export const K = 'gemie.accounts';

/** Product names, the same in every language. */
export const PLATFORM_LABELS: Record<GemieAccountPlatform, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
};

/** Each platform's own mark, in its own colour: a logo, the same in either theme. */
const PLATFORM_MARKS = {
  whatsapp: { Icon: RiWhatsappFill, color: '#25D366' },
  telegram: { Icon: RiTelegramFill, color: '#26A5E4' },
} as const;

export function PlatformMark({
  platform,
  size = 24,
}: {
  platform: GemieAccountPlatform;
  size?: number;
}) {
  const { Icon, color } = PLATFORM_MARKS[platform];
  return <Icon width={size} height={size} fill={color} />;
}

/** Which account it is, as a person reads it: `WhatsApp · +34 600…`. */
export function accountName(account: ConnectedAccount): string {
  const who = account.phoneNumber || account.displayName;
  const platform = PLATFORM_LABELS[account.platform] ?? account.platform;
  return who ? `${platform} · ${who}` : platform;
}

/**
 * The account's status in words. Telegram's mean something of their own: a link waiting in
 * Telegram, an account the person paused there, one connected again elsewhere. None asks them to
 * sign in again.
 */
export function statusText(account: ConnectedAccount, t: Translate): string {
  if (!GEMIE_ACCOUNT_STATUSES.includes(account.status)) return account.status;
  return account.platform === 'telegram' && account.status !== 'connected'
    ? t(`${K}.telegram.status.${account.status}`)
    : t(`${K}.status.${account.status}`);
}
