import { GemieSharedConversation, type GemieChatLabels } from '@gemies/sdk';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/shared/i18n/use-translation';
import config from '@/shared/platform/config';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * A shared conversation (`/shared/<token>`): the one public page every app's share link opens
 * (`gemiesSharedConversationUrl`, `docs/agent-embedding.md` §6), whichever agent led it and
 * whichever app it was minted in. Anybody with the link reads it, signed in or not; the thread
 * is the SDK's, read-only, with the canvas artifacts Alia drew and no other tool's output. Not for search engines: a share is
 * somebody's conversation, handed to the people they chose.
 */
export default function SharedConversationScreen() {
  const styles = useStyles();
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { t, locale } = useTranslation();
  const labels = useMemo<Partial<GemieChatLabels>>(() => ({ t, locale }), [t, locale]);

  return (
    <>
      <Head>
        <title>{t('sharedConversation.pageTitle')}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Screen
        scroll="content"
        documentScroll
        header={
          <PageHeader
            title={t('sharedConversation.title')}
            backLabel={t('sharedConversation.open')}
            onBack={() => router.replace('/(app)')}
          />
        }
      >
        <View style={styles.fill}>
          {token ? (
            <GemieSharedConversation token={token} apiUrl={config.apiUrl} labels={labels} />
          ) : null}
        </View>
        <Text style={styles.mutedText}>{t('sharedConversation.footer')}</Text>
      </Screen>
    </>
  );
}

const useStyles = createTokenStyles((t) => ({
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  mutedText: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    textAlign: 'center',
    fontSize: 12,
    color: t.mutedForeground,
    lineHeight: 16,
  },
}));
