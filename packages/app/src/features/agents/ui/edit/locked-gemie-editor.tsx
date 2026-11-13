import { AgentAccountsSection } from '@/features/agents/ui/edit/sections/agent-accounts-section';
import { agentDisplayName } from '@/features/agents/model/identity';
import type { Agent } from '@/shared/contracts/agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { ALIA_GEMIE_ID, GemieAvatar, readAgentCharacter } from '@gemies/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { Text } from '@oxy.so/bloom/typography';
import { ScrollView, View } from 'react-native';

/** The avatar size of the locked editor's header. */
const AVATAR = 56;

/**
 * The editor of a gemie whose identity the person may not change but whose connected accounts they
 * may manage (`viewer.mayManageAccounts` without `mayEdit`): Alia, every person's own assistant
 * (ADR 0035). Who she is shows as text, never as fields that would save nothing — her identity is
 * Oxy's, and the API refuses any edit of it — and the one card the person can use is their own
 * accounts on her.
 *
 * Her name and look are the SDK's until her Oxy account exists (ADR 0034): the card has no name
 * for her yet, so the header draws her the way the sidebar does.
 */
export function LockedGemieEditor({ agent, onClose }: { agent: Agent; onClose?: () => void }) {
  const { t } = useTranslation();
  const isAlia = agent._id === ALIA_GEMIE_ID;
  const name = isAlia ? 'Alia' : agentDisplayName(agent);

  return (
    <View className="flex-1 bg-background" testID="locked-gemie-editor">
      <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
        {isAlia ? (
          <GemieAvatar size={AVATAR} portrait />
        ) : (
          <AgentAvatar character={readAgentCharacter(agent.character)} size={AVATAR} />
        )}
        <View className="flex-1 gap-0.5">
          <Text variant="body-2-semibold">{name}</Text>
          <Text variant="body-2-regular" className="text-text-secondary" numberOfLines={2}>
            {isAlia ? t('gemies.aliaTagline') : agent.tagline}
          </Text>
        </View>
        {onClose ? (
          <Button
            size="sm"
            appearance="subtle"
            tone="neutral"
            iconOnly
            leadingIcon={RiCloseLine}
            accessibilityLabel={t('agents.editor.close')}
            onPress={onClose}
          />
        ) : null}
      </View>
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Text variant="body-2-regular" className="text-text-secondary">
          {t('agents.editor.lockedIdentity', { name })}
        </Text>
        <AgentAccountsSection agentId={agent._id} name={name} />
      </ScrollView>
    </View>
  );
}
