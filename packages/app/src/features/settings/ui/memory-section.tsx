import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { useUserData } from '@/features/memory/runtime/use-user-data';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import apiClient from '@/shared/api/client';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';

import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';

/** This page's own strings. */
const K = 'settings.assistant.memory';

/** What Alia remembers about the person lives in the `memories` database of their Nilo workspace. */
const NILO_URL = 'https://nilo.so';

export function MemorySection() {
  const { isAuthenticated } = useOxy();
  const { signIn } = useAuth();
  const { memory } = useUserData();
  const setMemory = useUserDataStore((state) => state.setMemory);
  const { t } = useTranslation();
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
    }
  }, [isAuthenticated, signIn]);

  const handleToggleRecall = async (recallEnabled: boolean) => {
    if (!isAuthenticated || !memory) return;

    setUpdating(true);
    try {
      const response = await apiClient.put('/memory/settings', { recallEnabled });
      setMemory({ ...memory, settings: response.data });
    } catch (error) {
      console.error('Error updating memory settings:', error);
      toast.error(t('memory.failedToSaveSettings'));
    } finally {
      setUpdating(false);
    }
  };

  const openNilo = () => {
    Linking.openURL(NILO_URL).catch(() => toast.error(t(`${K}.openNiloFailed`)));
  };

  return (
    <View style={styles.stack}>
      <GroupedSection>
        <GroupedSectionItem
          titleNumberOfLines={0}
          descriptionLines={0}
          wrapControl
          title={t(`${K}.niloTitle`)}
          description={t(`${K}.niloDescription`)}
          rightElement={
            <>
              <Button size="sm" appearance="outline" tone="neutral" onPress={openNilo}>
                {t(`${K}.openNilo`)}
              </Button>
            </>
          }
        />
        <GroupedSectionItem
          titleNumberOfLines={0}
          descriptionLines={0}
          wrapControl
          title={t('memory.recallToggleLabel')}
          description={t('memory.recallToggleDescription')}
          rightElement={
            <>
              <Switch
                accessibilityLabel={t('memory.recallToggleLabel')}
                checked={memory?.settings?.recallEnabled ?? true}
                onCheckedChange={handleToggleRecall}
                disabled={updating}
              />
            </>
          }
        />
      </GroupedSection>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { width: '100%', gap: 24 },
});
