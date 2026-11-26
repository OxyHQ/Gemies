import { useLabels } from '../lib/labels';
import { FAILED_TURN_TOAST_ID } from './useFailedTurnToast';
import type { AgentActivityState } from '../runtime/thread/agent-activity';
import { toast } from '@oxy.so/bloom/toast';
import { useEffect } from 'react';

const AGENT_RUN_FAILURE_TOAST_MS = 10_000;

/**
 * A run that ended in error is told with a toast, never with a panel in the conversation: the
 * thread keeps the person's words and the agent's, and a failure is not part of either. The words
 * are the server's (why it failed), under the app's own line. A run that ended well still leaves its
 * summary card (`AgentResultCard`); this is for the one that did not, unless the turn's own failure
 * toast already told it. The two share one toast id: the run's failure reaches the thread before the
 * turn's does, and the turn's toast, which can Retry, replaces it instead of stacking beside it.
 */
export function useAgentRunFailureToast(
  activity: AgentActivityState | null | undefined,
  failedTurn?: unknown,
) {
  const { t } = useLabels();
  // When the turn itself failed, its own toast already says so (`useFailedTurnToast`).
  const failed = activity?.hasError === true && !failedTurn;
  const detail = activity?.lastError ?? undefined;

  useEffect(() => {
    if (!failed) return;
    toast.error(t('chat.agentRun.taskFailed'), {
      id: FAILED_TURN_TOAST_ID,
      description: detail,
      duration: AGENT_RUN_FAILURE_TOAST_MS,
    });
  }, [failed, detail, t]);
}
