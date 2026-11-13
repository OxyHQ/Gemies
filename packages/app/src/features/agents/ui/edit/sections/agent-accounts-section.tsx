import { useTranslation } from '@/shared/i18n/use-translation';
import { AgentCreatorSection } from '@oxy.so/bloom/agent-creator';
import { GemieAccounts } from '@gemies/sdk/accounts';

/**
 * The WhatsApp and Telegram accounts the person linked to this gemie (ADR 0035), as a card of the
 * editor. The panel itself is the SDK's (`@gemies/sdk/accounts`), the same one the Alia app draws
 * for Alia's gemie in its settings.
 */
export function AgentAccountsSection({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  return (
    <AgentCreatorSection title={t('gemie.accounts.title')}>
      <GemieAccounts gemieId={agentId} name={name} t={t} />
    </AgentCreatorSection>
  );
}
