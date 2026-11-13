import { ChatWorkspace } from '@/features/chat/ui/chat-workspace';
import { AgentThreadScreen } from '@/features/agents/ui/agent-thread-screen';
import { useAgentThread } from '@/features/agents/runtime/use-agent-thread';
import { usePersonProfile } from '@/features/profile/runtime/use-person-profile';
import { UserProfile } from '@/features/profile/ui/user-profile';
import { AiChatMobileHeader } from '@oxy.so/bloom/ai-chat';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

/**
 * `/@pepe` — what the username is: the permanent thread with an agent, or a person's profile.
 *
 * Which one is decided by the account. An agent is a `kind: 'bot'` account in Oxy and opens its
 * thread (`AgentThreadScreen`, the same screen a gemie with no handle opens at `/agents/<id>`); a
 * person's account opens their profile (`UserProfile`, Bloom's AI profile card). Both are looked up
 * at once, so the agent's thread waits for nothing. A username that is neither (no such account, an
 * agent nobody may reach) is the one agent 404, as before.
 *
 * ## The `@` is in the VALUE, not in the filename
 *
 * Expo Router does not mix static text with a dynamic segment, so there is no
 * `@[username].tsx`. `/@pepe` matches this file with `username` set to the whole
 * `"@pepe"`, and the sigil is stripped here — the same shape Mention uses.
 *
 * ## Which makes this the app's catch-all for one-segment paths
 *
 * A dynamic segment at the root of the group swallows every single-segment URL
 * that no static route claims. Expo Router prefers a static route over a dynamic
 * one, so `/settings` still reaches `settings` — asserted for every static route
 * and directory in `__tests__/single-segment-routes.test.ts`, because that
 * preference is the only thing standing between this file and the rest of the
 * app.
 *
 * What it does mean is that `/anything-that-is-not-a-route` lands HERE and gets
 * the agent 404. That is deliberate rather than a side effect: the thread's
 * refusal is already built to reveal nothing — an agent that does not exist, an
 * agent you cannot reach and a path that is not a route are one answer — and a
 * separate generic 404 would be a second page saying less.
 */
const AgentThreadPage = () => {
  const { username, threadId } = useLocalSearchParams<{
    username: string;
    threadId?: string;
  }>();

  /**
   * The handle Oxy knows, stripped of the sigil the URL carries.
   *
   * Normalised in ONE place and for any number of `@`: `/@pepe`, `/pepe` and
   * `/@@pepe` are the same person, and three spellings that reached three
   * behaviours would be three bugs nobody could tell apart. What goes to the API
   * is the bare username, which is what `GET /agents/thread/:username` expects.
   */
  const handle = username?.replace(/^@+/, '') ?? '';
  const thread = useMemo(() => ({ handle }), [handle]);
  const { data } = useAgentThread(thread, threadId);
  // A thread asked for by id is an agent's by construction; otherwise the account may be a person.
  const { person, isPending: profilePending } = usePersonProfile(
    threadId === undefined ? handle : '',
  );

  // A person's account wins over a thread that does not exist: an agent has a thread or nothing.
  if (data === undefined && person !== undefined) {
    return (
      <ChatWorkspace header={<AiChatMobileHeader title="Alia" />}>
        <UserProfile user={person} />
      </ChatWorkspace>
    );
  }

  return <AgentThreadScreen thread={thread} threadId={threadId} resolving={profilePending} />;
};

export default AgentThreadPage;
