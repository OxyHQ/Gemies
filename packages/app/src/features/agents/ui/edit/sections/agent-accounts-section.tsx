import { useAliaSettings } from '@/features/settings/ui/settings-context';
import { useTranslation } from '@/shared/i18n/use-translation';
import { GemieAccountGrants } from '@gemies/sdk/accounts';
import { AgentCreatorSection } from '@oxy.so/bloom/agent-creator';

/**
 * The person's WhatsApp and Telegram accounts this gemie may use (ADR 0035 as amended), one switch
 * each, as a card of its editor: the accounts are the person's, connected once in Settings ›
 * Connected accounts, where they also choose which gemie answers each on its own. The list is the
 * SDK's (`@gemies/sdk/accounts`), the same rows as the connectors this gemie may use.
 */
export function AgentAccountsSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const settings = useAliaSettings();
  return (
    <AgentCreatorSection title={t('gemie.accounts.grants.title', { name })}>
      <GemieAccountGrants
        gemieId={agentId}
        name={name}
        onManage={() => settings.open('accounts')}
        t={t}
      />
    </AgentCreatorSection>
  );
}
