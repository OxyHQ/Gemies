import { useCallback, useEffect, useState } from 'react';
import { useRealtimeTopic } from '../realtime/react';
import type { RealtimeFrame } from '../realtime/contract';
import { useGemieApi } from './api';
import { AGENT_ROUTES } from './routes';
import {
  type AgentActivityEvent,
  type AgentActivityState,
  type AgentSessionStatus,
  applyActivityEvent,
  hydrateActivity,
  INITIAL_ACTIVITY,
} from './thread/agent-activity';

/** What a run has done so far, live. */
export type UseAgentActivityResult = AgentActivityState;

/**
 * Follow one agent run live: its session's topic on the account's realtime connection
 * (`agent-session:<id>`, `docs/realtime.mdx`), seeded with what the run had already done (`GET` on
 * its status, best-effort — the topic still carries live progress).
 *
 * @param sessionId - The agent session to follow; `null` follows nothing.
 * @param agentId - The agent's own topic too, for the runs that announce themselves there.
 */
export function useAgentActivity(
  sessionId: string | null,
  agentId?: string | null,
): UseAgentActivityResult {
  const [state, setState] = useState<AgentActivityState>(INITIAL_ACTIVITY);
  const api = useGemieApi();

  useEffect(() => {
    if (!sessionId) return;
    setState(INITIAL_ACTIVITY);
    let cancelled = false;
    api
      .get<AgentSessionStatus>(AGENT_ROUTES.sessionStatus(sessionId))
      .then(({ data }) => {
        if (!cancelled) setState((prev) => hydrateActivity(prev, data, sessionId));
      })
      .catch(() => {
        // The topic still provides live progress; hydration is best-effort.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, api]);

  const onFrame = useCallback(
    (frame: RealtimeFrame) => {
      const event = frame.data as AgentActivityEvent;
      if (event?.sessionId === sessionId) setState((prev) => applyActivityEvent(prev, event));
    },
    [sessionId],
  );
  useRealtimeTopic(sessionId ? `agent-session:${sessionId}` : null, onFrame);
  useRealtimeTopic(sessionId && agentId ? `agent:${agentId}` : null, onFrame);

  return state;
}
