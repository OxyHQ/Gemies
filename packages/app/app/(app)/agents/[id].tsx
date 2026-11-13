import { AgentThreadScreen } from '@/features/agents/ui/agent-thread-screen';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

/**
 * `/agents/<id>` — the permanent thread with a gemie that has no handle to address it by: one with
 * no Oxy account (ADR 0036, an external agent), which only its owner opens, or one whose account Oxy
 * did not resolve. A gemie with a handle opens at `/@handle`; this is the same screen
 * (`AgentThreadScreen`), asked of the API by the gemie's id (`GET /agents/:id/thread`).
 */
export default function AgentThreadByIdScreen() {
  const { id, threadId } = useLocalSearchParams<{ id: string; threadId?: string }>();
  const thread = useMemo(() => ({ gemieId: id ?? '' }), [id]);
  return <AgentThreadScreen thread={thread} threadId={threadId} />;
}
