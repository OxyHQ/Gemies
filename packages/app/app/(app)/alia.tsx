import { ChatWorkspace } from '@/features/chat/ui/chat-workspace';
import { ConversationScreen } from '@/features/chat/ui/conversation-screen';
import { WelcomeIntro } from '@/features/chat/ui/welcome-intro';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from '@/shared/i18n/use-translation';
import { AiChatMobileHeader } from '@oxy.so/bloom/ai-chat';
import Head from 'expo-router/head';
import { useCallback, useState } from 'react';

/**
 * `/alia` — a new chat with Alia, one of the person's gemies (ADR 0034): the conversation screen
 * with no conversation yet. Its first turn creates one, and the route is replaced by that
 * conversation's. The home (`index.tsx`) lists her with the person's other gemies.
 *
 * Until Alia is an `agents` row (ADR 0034 phase 3) her chat is still the turn without an agent,
 * which is why she has this route and not `/@alia` like every other gemie.
 */
const AliaChatPage = () => {
  const { t } = useTranslation();
  const { isAuthenticated, isAuthResolved } = useAuth();

  /**
   * Signed out means the intro, every time — not only on a first visit.
   *
   * It used to latch on a persisted `welcomeSeen`, so somebody who had once
   * dismissed it landed on a chat panel with no explanation of what this is.
   * Whether a person has met Alia is not a fact about their browser's storage;
   * it is whether they have an account. So the account is the whole gate, and
   * the flag it used to read — along with the hydration wait that existed only
   * to read it safely — is gone.
   *
   * Still gated on `isAuthResolved` so a cold-boot reload with a live session
   * never flashes it. Once showing it is latched by `introState`: the intro
   * signs the user in while its exit is still playing, and letting
   * `isAuthenticated` flip the gate mid-animation would tear it off the screen.
   */
  const [introState, setIntroState] = useState<'idle' | 'showing' | 'done'>('idle');
  if (introState === 'idle' && isAuthResolved && !isAuthenticated) {
    setIntroState('showing');
  }
  const handleIntroDismissed = useCallback(() => setIntroState('done'), []);

  return (
    <>
      <Head>
        <title>Alia \ Gemies</title>
        <meta name="description" content={t('landing.metaDescription')} />
        <link rel="canonical" href="https://gemies.ai/alia" />
        <meta property="og:title" content="Alia \ Gemies" />
        <meta property="og:description" content={t('landing.metaDescription')} />
      </Head>
      {introState === 'showing' ? (
        <WelcomeIntro onDismissed={handleIntroDismissed}>
          {(intro) => (
            <ChatWorkspace
              header={<AiChatMobileHeader title="Alia" />}
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

export default AliaChatPage;
