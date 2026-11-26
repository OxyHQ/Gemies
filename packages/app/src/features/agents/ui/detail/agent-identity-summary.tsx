import { agentDisplayName } from '@/features/agents/model/identity';
import { agentHandle } from '@/shared/routing/agent-address';
import { useTranslation } from '@/shared/i18n/use-translation';
import { formatCompactNumber } from '@oxy.so/bloom/locale';
import type { Agent } from '@/shared/contracts/agents';
import { readAgentCharacter } from '@gemies/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Rating } from '@oxy.so/bloom/rating';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { View, StyleSheet } from 'react-native';

/** The agent's status, as the tone of Bloom's status dot and badge. */
const STATUS_TONE = {
  active: 'success',
  idle: 'warning',
  offline: 'default',
} as const;

/**
 * Who the agent is: the mark in its own colour carrying the status dot, the
 * name, handle and author, the tagline, and how it has been received.
 */
export function AgentIdentitySummary({ agent }: { agent: Agent }) {
  const { t, locale } = useTranslation();
  const handle = agentHandle(agent);

  return (
    <View style={styles.summary}>
      <View style={styles.avatar}>
        <Badge dot color={STATUS_TONE[agent.status]} placement="bottom-right">
          <AgentAvatar
            size={80}
            character={readAgentCharacter(agent.character, agent.color)}
            label={agentDisplayName(agent)}
          />
        </Badge>
      </View>
      <View style={styles.nameRow}>
        <Text variant="title-3-semibold">{agentDisplayName(agent)}</Text>
        <Badge
          size="label-small"
          variant="subtle"
          color={STATUS_TONE[agent.status]}
          content={t(
            `agents.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`,
          )}
        />
      </View>
      {/* Handle + Author — both read from Oxy, both absent when it could
          not resolve the account, so an unresolved agent shows no row of
          separators around nothing. */}
      {(handle !== '' || agent.authorName !== null) && (
        <Muted>
          {[handle !== '' ? `@${handle}` : null, agent.authorName]
            .filter((part) => part !== null)
            .join(' · ')}
        </Muted>
      )}
      {agent.tagline ? <Text variant="body-regular">{agent.tagline}</Text> : null}
      <View style={styles.meta}>
        <Rating value={agent.rating} count={agent.reviewCount} size="sm" />
        <Muted>
          {formatCompactNumber(agent.hireCount, locale)} {t('agents.hires')} ·{' '}
          {formatCompactNumber(agent.usageCount, locale)} {t('agents.uses')}
        </Muted>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { gap: 6 },
  avatar: { alignSelf: 'flex-start' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
