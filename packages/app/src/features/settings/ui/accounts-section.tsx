import { useTranslation } from '@/shared/i18n/use-translation';
import { GemieConnectedAccounts } from '@gemies/sdk/accounts';

/**
 * Settings › Connected accounts (ADR 0035 as amended): the person's WhatsApp and Telegram, connected
 * once, each granted to the gemies that may use it and answered by at most one of them. The panel
 * is the SDK's, the same one the Alia app draws; a gemie's editor shows the same grants from the
 * gemie's side (`AgentAccountsSection`).
 */
export function AccountsSection() {
  const { t } = useTranslation();
  return <GemieConnectedAccounts t={t} />;
}
