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
import { createTokenStyles } from '@oxy.so/bloom/theme';

/** The avatar size of the locked editor's header. */
const AVATAR = 56;

/**
 * The editor of a gemie whose identity the person may not change but to which they may grant their
 * connected accounts (`viewer.mayGrantAccounts` without `mayEdit`): Alia, every person's own
 * assistant (ADR 0035 as amended). Who she is shows as text, never as fields that would save nothing
 * — her identity is Oxy's, and the API refuses any edit of it — and the one card the person can use
 * is which of their accounts she may use, the same switches every gemie's editor has.
 *
 * Her name and look are the SDK's until her Oxy account exists (ADR 0034): the card has no name
 * for her yet, so the header draws her the way the sidebar does.
 */
export function LockedGemieEditor({ agent, onClose }: { agent: Agent; onClose?: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const isAlia = agent._id === ALIA_GEMIE_ID;
  const name = isAlia ? 'Alia' : agentDisplayName(agent);

  return (
    <View style={styles.surface} testID="locked-gemie-editor">
      <View style={styles.row}>
        {isAlia ? (
          <GemieAvatar size={AVATAR} portrait />
        ) : (
          <AgentAvatar character={readAgentCharacter(agent.character, agent.color)} size={AVATAR} />
        )}
        <View style={styles.headerText}>
          <Text variant="body-2-semibold">{name}</Text>
          <Text variant="body-2-regular" style={styles.mutedText} numberOfLines={2}>
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
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="body-2-regular" style={styles.mutedText}>
          {t('agents.editor.lockedIdentity', { name })}
        </Text>
        <AgentAccountsSection agentId={agent._id} name={name} />
      </ScrollView>
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  surface: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderColor: t.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerText: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 2 },
  mutedText: { color: t.mutedForeground },
  content: { gap: 16, padding: 16 },
}));
