/**
 * `/__fixtures/telegram-bot` — the gemie editor's Telegram bot section, over a bot held in the query
 * cache instead of fetched, so the visual harness can look at it without an account or an API.
 *
 * Fixtures build only (`fixtures/entry.tsx`). `window.__aliaFixture.telegramBot.link(who)` and
 * `.unlink()` change the bot as the server's answer would after the person linked or unlinked their
 * Telegram (the realtime event invalidates the query; here the cache is set directly), so a browser
 * sees the section follow the state with no reload.
 */
import { AgentTelegramBotSection } from '@/features/agents/ui/edit/sections/agent-telegram-bot-section';
import type { GemieTelegramBotAnswer } from '@/features/agents/runtime/use-gemie-telegram-bot';
import { queryKeys } from '@/shared/api/query-keys';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

const AGENT_ID = 'fixture-gemie';

function answer(linkedAs: string | null): GemieTelegramBotAnswer {
  return {
    available: true,
    bot: {
      botId: '8000000002',
      username: 'eusebio_bot',
      name: 'Eusebio',
      status: 'active',
      groupReplies: 'mentions',
      ownerPaysAgentTurns: true,
      callerPays: true,
      personLinked: linkedAs !== null,
      linkedAs,
      totalMessages: 42,
      lastMessageAt: null,
      profileSyncError: null,
      live: null,
    },
  } as GemieTelegramBotAnswer;
}

interface FixtureWindow {
  __aliaFixture?: { telegramBot?: { link: (who: string) => void; unlink: () => void } };
}

export default function TelegramBotFixture() {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const key = queryKeys.agents.telegramBot(AGENT_ID);
    // Never stale: the section reads the cache and does not fetch.
    queryClient.setQueryDefaults(key, { staleTime: Number.POSITIVE_INFINITY });
    queryClient.setQueryData(key, answer(null));
    const w = window as unknown as FixtureWindow;
    w.__aliaFixture = {
      ...w.__aliaFixture,
      telegramBot: {
        link: (who) => queryClient.setQueryData(key, answer(who)),
        unlink: () => queryClient.setQueryData(key, answer(null)),
      },
    };
    setReady(true);
  }, [queryClient]);
  if (!ready) return null;
  return (
    <ScrollView contentContainerClassName="p-4">
      <AgentTelegramBotSection
        agentId={AGENT_ID}
        name="Eusebio"
        look={{ character: { preset: 'blue_beret' } as never, color: '#b6d80d' }}
      />
    </ScrollView>
  );
}
