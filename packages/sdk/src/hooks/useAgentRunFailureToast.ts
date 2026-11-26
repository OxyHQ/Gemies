import { useLabels } from '../lib/labels';
import type { AgentActivityState } from '../runtime/thread/agent-activity';
import { toast } from '@oxy.so/bloom/toast';
import { useEffect } from 'react';

/** One toast for the run that failed, replaced by the next failure. */
export const AGENT_RUN_FAILURE_TOAST_ID = 'agent-run-failure';
const AGENT_RUN_FAILURE_TOAST_MS = 10_000;

/**
 * A run that ended in error is told with a toast, never with a panel in the conversation: the
 * thread keeps the person's words and the agent's, and a failure is not part of either. The words
 * are the server's (why it failed), under the app's own line. A run that ended well still leaves its
 * summary card (`AgentResultCard`); this is for the one that did not, unless the turn's own failure
 * toast already told it.
 */
export function useAgentRunFailureToast(
  activity: AgentActivityState | null | undefined,
  failedTurn?: unknown,
) {
  const { t } = useLabels();
  // When the turn itself failed, its own toast already says so (`useFailedTurnToast`).
  const failed = activity?.isComplete === true && activity.hasError && !failedTurn;
  const detail = activity?.lastError ?? undefined;

  useEffect(() => {
    if (!failed) return;
    toast.error(t('chat.agentRun.taskFailed'), {
      id: AGENT_RUN_FAILURE_TOAST_ID,
      description: detail,
      duration: AGENT_RUN_FAILURE_TOAST_MS,
    });
  }, [failed, detail, t]);
}
