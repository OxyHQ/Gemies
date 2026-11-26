import { agentDisplayName } from '@/features/agents/model/identity';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { readAgentCharacter } from '@gemies/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Button } from '@oxy.so/bloom/button';
import { ListItem } from '@oxy.so/bloom/list';
import { Text } from '@oxy.so/bloom/typography';
import React from 'react';
import { View } from 'react-native';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * One agent in the catalogue, as a row: its mark, its name with "by author" after it, its tagline
 * under that, and Chat at the end. The whole row opens the agent's page; Chat opens its thread.
 * Rows sit two to a line where there is room, so the catalogue reads as a list to scan, not a wall
 * of cards.
 */
export const AgentListingRow = React.memo(function AgentListingRow({
  agent,
  onPress,
  onChat,
}: {
  agent: Agent;
  onPress: (id: string) => void;
  onChat: (id: string) => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const name = agentDisplayName(agent);
  const author = agent.authorName?.trim();
  return (
    <ListItem
      role="listitem"
      label={name}
      onPress={() => onPress(agent._id)}
      leading={
        <View pointerEvents="none">
          <AgentAvatar
            size={36}
            character={readAgentCharacter(agent.character, agent.color)}
            portrait
          />
        </View>
      }
      title={
        <Text numberOfLines={1} style={styles.name}>
          {name}
          {author ? (
            <Text style={styles.author}> {t('agents.byAuthor', { name: author })}</Text>
          ) : null}
        </Text>
      }
      supporting={agent.tagline}
      supportingLines={1}
      trailing={
        <Button
          tone="neutral"
          appearance="subtle"
          stopPropagation
          onPress={() => onChat(agent._id)}
        >
          {t('agents.chat')}
        </Button>
      }
    />
  );
});

const useStyles = createTokenStyles((t) => ({
  name: { fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  author: { fontSize: 14, fontWeight: 400, color: t.mutedForeground, lineHeight: 20 },
}));
