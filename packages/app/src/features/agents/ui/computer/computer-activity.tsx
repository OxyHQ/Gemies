import { View, StyleSheet } from 'react-native';
import { Muted, Text } from '@oxy.so/bloom/typography';
import type { ComputerReceipts } from '@/features/agents/model/computer';
import { useTranslation } from '@/shared/i18n/use-translation';

const time = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

/**
 * What the agent recently ran and did in its browser — the host's receipts,
 * read-only. Commands show what ran and how it ended, never its output; browser
 * actions show who acted and on which site, never what was typed.
 */
export function ComputerActivity({ receipts }: { receipts: ComputerReceipts | undefined }) {
  const { t } = useTranslation();
  const commands = receipts?.commands ?? [];
  const browser = receipts?.browser ?? [];

  return (
    <View style={styles.activity} testID="computer-activity">
      <View style={styles.group}>
        <Text variant="body-medium">{t('agents.computer.activity.commands')}</Text>
        {commands.length === 0 ? <Muted>{t('agents.computer.activity.none')}</Muted> : null}
        {commands.map((command) => (
          <View key={command.operationId} style={styles.entry}>
            <Text variant="body-regular" numberOfLines={2} style={{ fontFamily: 'monospace' }}>
              {command.command}
            </Text>
            <Muted>
              {t(`agents.computer.activity.status.${command.status}`)}
              {command.exitCode !== null ? ` · exit ${command.exitCode}` : ''}
              {` · ${time(command.startedAt)}`}
            </Muted>
          </View>
        ))}
      </View>
      <View style={styles.group}>
        <Text variant="body-medium">{t('agents.computer.activity.browser')}</Text>
        {browser.length === 0 ? <Muted>{t('agents.computer.activity.none')}</Muted> : null}
        {browser.map((action, index) => (
          <View key={`${action.at}-${index}`} style={styles.entry}>
            <Text variant="body-regular" numberOfLines={1}>
              {t(`agents.computer.activity.action.${action.action}`)}
              {action.origin ? ` · ${action.origin}` : ''}
            </Text>
            <Muted>
              {t(`agents.computer.activity.by.${action.by}`)}
              {` · ${t(`agents.computer.activity.status.${action.status}`)}`}
              {action.detail ? ` · ${action.detail}` : ''}
              {` · ${time(action.at)}`}
            </Muted>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  activity: { gap: 16 },
  group: { gap: 6 },
  entry: { gap: 2, paddingVertical: 4 },
});
