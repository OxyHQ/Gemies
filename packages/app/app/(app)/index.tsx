import { agentDisplayName } from '@/features/agents/model/identity';
import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { useNewAgentConversation } from '@/features/agents/runtime/use-new-agent-conversation';
import type { Agent } from '@/shared/contracts/agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { agentChatRoute } from '@/shared/routing/agent-address';
import { GemiesLogo } from '@/shared/ui/gemies-mark';
import { AliaAvatar, readAgentCharacter } from '@alia.onl/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Button } from '@oxy.so/bloom/button';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { Item } from '@oxy.so/bloom/item';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { Stack, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ScrollView, View } from 'react-native';

/**
 * The Gemies home: the person's gemies, Alia among them (ADR 0034 §1 — the Gemies app has no
 * conversation without a gemie). Each one opens its own chat; there is no loose "new chat" here.
 *
 * A first version: Alia, then the gemies the person made (`GET /agents/me`, the sidebar's own
 * list), and the two ways to get more — creating one (by talking to Alia) and the catalogue.
 * Signed out it says what Gemies is and asks to sign in with Oxy.
 */
export default function GemiesHome() {
  const { t } = useTranslation();
  const { isAuthenticated, isAuthResolved } = useAuth();

  return (
    <>
      <Head>
        <title>Gemies</title>
        <meta name="description" content={t('gemies.metaDescription')} />
        <link rel="canonical" href="https://gemies.ai/" />
        <meta property="og:title" content="Gemies" />
        <meta property="og:description" content={t('gemies.metaDescription')} />
      </Head>
      <Stack.Screen options={{ title: t('gemies.name') }} />
      {!isAuthResolved ? <GemieListSkeleton /> : isAuthenticated ? <GemieList /> : <SignedOut />}
    </>
  );
}

function SignedOut() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  return (
    <View className="flex-1 items-center justify-center gap-4 px-4 py-16">
      <GemiesLogo size={40} />
      <Text variant="headline-semibold" className="text-center">
        {t('gemies.tagline')}
      </Text>
      <Muted className="max-w-md text-center">{t('gemies.signedOutHint')}</Muted>
      <Button size="lg" tone="action" onPress={() => signIn().catch(() => {})}>
        {t('gemies.signIn')}
      </Button>
    </View>
  );
}

function GemieList() {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: agents, isPending } = useMyAgents();
  const createGemie = useNewAgentConversation();
  const openGemie = (agent: Agent) => {
    const route = agentChatRoute(agent);
    if (route !== null) router.push(route);
  };

  return (
    <ScrollView className="flex-1" contentContainerClassName="px-4 pb-8">
      <View className="gap-1 pb-4 pt-4">
        <Text variant="headline-semibold">{t('gemies.yourGemies')}</Text>
        <Muted>{t('gemies.tagline')}</Muted>
      </View>
      <View role="list">
        <Item
          role="listitem"
          accessibilityLabel={t('gemies.chatWith', { name: 'Alia' })}
          onPress={() => router.push('/alia')}
          leading={<AliaAvatar size={40} portrait />}
          title="Alia"
          subtitle={t('gemies.aliaTagline')}
          subtitleNumberOfLines={1}
        />
        {isPending ? (
          <GemieRowsSkeleton count={3} />
        ) : (
          (agents ?? []).map((agent) => (
            <Item
              key={agent._id}
              role="listitem"
              accessibilityLabel={t('gemies.chatWith', { name: agentDisplayName(agent) })}
              onPress={() => openGemie(agent)}
              leading={
                <AgentAvatar size={40} character={readAgentCharacter(agent.character)} portrait />
              }
              title={agentDisplayName(agent)}
              subtitle={agent.tagline}
              subtitleNumberOfLines={1}
            />
          ))
        )}
      </View>
      {!isPending && (agents ?? []).length === 0 ? (
        <Muted className="px-3 pt-2">{t('gemies.emptyHint')}</Muted>
      ) : null}
      <View className="flex-row flex-wrap gap-2 px-3 pt-6">
        <Button size="md" tone="action" leadingIcon={RiAddLine} onPress={createGemie}>
          {t('gemies.create')}
        </Button>
        <Button size="md" tone="neutral" appearance="subtle" onPress={() => router.push('/agents')}>
          {t('gemies.explore')}
        </Button>
      </View>
    </ScrollView>
  );
}

/** Rows shaped like the list's `Item`s, while the person's gemies are on their way. */
function GemieRowsSkeleton({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="flex-row items-center gap-3 p-3">
          <Skeleton.Circle size={40} />
          <View className="flex-1 gap-1.5">
            <Skeleton.Box width="35%" height={13} />
            <Skeleton.Box width="70%" height={11} />
          </View>
        </View>
      ))}
    </>
  );
}

/** The whole page's shape, before the session is known. */
function GemieListSkeleton() {
  return (
    <View className="flex-1 px-4 pt-4">
      <View className="gap-2 pb-4">
        <Skeleton.Box width="30%" height={18} />
        <Skeleton.Box width="55%" height={12} />
      </View>
      <GemieRowsSkeleton count={4} />
    </View>
  );
}
