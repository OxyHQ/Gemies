import { ChatWorkspace } from '@/features/chat/ui/chat-workspace';
import { ConversationScreen } from '@/features/chat/ui/conversation-screen';
import { WelcomeIntro } from '@/features/chat/ui/welcome-intro';
import { useTranslation } from '@/shared/i18n/use-translation';
import { AiChatMobileHeader } from '@oxy.so/bloom/ai-chat';
import { useAuth } from '@oxy.so/services/ui/client';
import Head from 'expo-router/head';
import { useCallback, useState } from 'react';

/**
 * The Gemies home is a new chat with Alia, the gemie everybody has (ADR 0034): the conversation
 * screen with no conversation yet. Its first turn creates one, and the route is replaced by that
 * conversation's. The person's other gemies are in the sidebar, Alia first among them.
 */
const ChatPage = () => {
  const { t } = useTranslation();
  const { isAuthenticated, isAuthResolved } = useAuth();

  /**
   * Signed out means the Gemies intro, every time — not only on a first visit. Whether a person
   * has met Gemies is whether they have an account, not a fact about their browser's storage.
   *
   * Still gated on `isAuthResolved` so a cold-boot reload with a live session never flashes it.
   * Once showing it is latched by `introState`: the intro signs the person in while its exit is
   * still playing, and letting `isAuthenticated` flip the gate mid-animation would tear it off
   * the screen.
   */
  const [introState, setIntroState] = useState<'idle' | 'showing' | 'done'>('idle');
  if (introState === 'idle' && isAuthResolved && !isAuthenticated) {
    setIntroState('showing');
  }
  const handleIntroDismissed = useCallback(() => setIntroState('done'), []);

  return (
    <>
      <Head>
        <title>Gemies</title>
        <meta name="description" content={t('gemies.metaDescription')} />
        <link rel="canonical" href="https://gemies.ai/" />
        <meta property="og:title" content="Gemies" />
        <meta property="og:description" content={t('gemies.metaDescription')} />
      </Head>
      {introState === 'showing' ? (
        <WelcomeIntro brand="gemies" onDismissed={handleIntroDismissed}>
          {(intro) => (
            <ChatWorkspace
              header={<AiChatMobileHeader title={t('gemies.name')} />}
              background={intro.background}
            >
              {intro.content}
            </ChatWorkspace>
          )}
        </WelcomeIntro>
      ) : (
        <ConversationScreen />
      )}
    </>
  );
};

export default ChatPage;
