import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { useEmailAlerts } from '@/features/notifications/runtime/use-email-alerts';
import { SettingsRowsSkeleton } from '@/shared/ui/skeletons';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { View, StyleSheet } from 'react-native';

/** This page's own strings. */
const K = 'settings.assistant.proactive';

/**
 * When Alia and the agents may write first.
 *
 * Today one thing: an important email, Alia about the person's own Inbox. Each agent's own mailbox
 * is a switch in that agent's editor. On by default; the limits (three a day, none while
 * the last two are unanswered) are the same for everybody and not a setting.
 */
export function ProactiveSection() {
  const { t } = useTranslation();
  const { alerts, loading, failed, setEnabled } = useEmailAlerts();

  if (loading) {
    return <SettingsRowsSkeleton control="switch" />;
  }
  if (failed || !alerts) {
    return (
      <GroupedSection>
        <GroupedSectionItem wrapControl title={t(`${K}.loadFailed`)} />
      </GroupedSection>
    );
  }

  return (
    <View style={styles.stack}>
      <SettingsSection label={t(`${K}.emailTitle`)}>
        <GroupedSection>
          <GroupedSectionItem
            titleNumberOfLines={0}
            descriptionLines={0}
            wrapControl
            title={t(`${K}.aliaEmailLabel`)}
            description={t(`${K}.aliaEmailDescription`)}
            rightElement={
              <>
                <Switch
                  accessibilityLabel={t(`${K}.aliaEmailLabel`)}
                  checked={alerts.alia.enabled}
                  onCheckedChange={(enabled) => setEnabled(null, enabled)}
                />
              </>
            }
          />
        </GroupedSection>
      </SettingsSection>

      <GroupedSection>
        <GroupedSectionItem
          titleNumberOfLines={0}
          descriptionLines={0}
          wrapControl
          title={t(`${K}.limitsLabel`)}
          description={t(`${K}.limitsDescription`)}
        />
      </GroupedSection>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { width: '100%', gap: 24 },
});
