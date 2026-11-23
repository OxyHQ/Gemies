import { useAvatarFlights } from '@oxy.so/bloom/avatar-flight';
import { SelectedAgentPreview } from '@oxy.so/bloom/multi-agent-chat/selected-agent-preview';
import { Text, View } from 'react-native';
import { useMemo } from 'react';
import { useGemieFlights } from '../lib/flights';
import { useLabels } from '../lib/labels';
import type { GemieParticipant } from '../lib/participants';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * The empty chat of a GROUP: its members together, as Bloom's multi-agent chat draws them (one
 * large avatar, a trio, or a ring), above "A few minds, one conversation". Each avatar is named
 * `empty:<agent id>` for the chat's flights, the anchor Bloom's own group chat flies from.
 */
export function GemieGroupWelcome({ members }: { members: readonly GemieParticipant[] }) {
  const styles = useStyles();
  const { t } = useLabels();
  const shared = useGemieFlights();
  const own = useAvatarFlights();
  const agents = useMemo(
    () =>
      members.map((member) => ({
        id: member.id,
        name: member.name,
        label: '',
        description: '',
        avatar: member.character,
        // Already painted in it; a colour the member does not have leaves that paint.
        color: member.color ?? '',
      })),
    [members],
  );
  return (
    <View style={styles.welcome}>
      <SelectedAgentPreview agents={agents} flights={shared ?? own} anchor="empty" />
      <Text selectable={false} style={styles.greeting}>
        {t('chat.groupWelcome')}
      </Text>
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  welcome: { alignItems: 'center', gap: 16 },
  greeting: {
    maxWidth: 448,
    flexShrink: 1,
    textAlign: 'center',
    fontSize: 36,
    color: t.foreground,
    lineHeight: 40,
  },
}));
