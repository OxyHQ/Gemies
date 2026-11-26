import { ApprovalExpiredError } from '@gemies/sdk/runtime';
import { isAxiosError } from 'axios';
import apiClient from '@/shared/api/client';
import { API_ROUTES } from '@/shared/api/routes';

/**
 * Carries the person's answer to a coding CLI that asked to run something on their computer
 * (Gemies ADR 0043 §5): `allow` or `deny`, for one request of one external agent. The CLI waits for
 * it; Gemies hands it on to the person's computer.
 *
 * This is the CLI's own prompt to the person who runs it — the answer goes to Gemies and nowhere
 * else, and nothing here is an Oxy grant. A 404 means the question is no longer open (it timed out,
 * or was answered from another screen): the conversation shows that, rather than offering a retry.
 */
export async function decideApproval(
  requestId: string,
  agentId: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  try {
    await apiClient.post(API_ROUTES.agents.external.approval(agentId, requestId), { decision });
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 404) throw new ApprovalExpiredError();
    throw error;
  }
}
