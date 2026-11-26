import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The person's answer to a coding CLI that asked to run something on their computer (ADR 0043 §5):
 * one POST for one request of one external agent, and a question that is no longer open reads as
 * such instead of as a failure to retry.
 */

const state = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@/shared/api/client', () => ({ default: { post: state.post } }));
// The SDK's runtime pulls in React Native; only its error class matters here.
vi.mock('@gemies/sdk/runtime', () => ({
  ApprovalExpiredError: class ApprovalExpiredError extends Error {},
}));

import { ApprovalExpiredError } from '@gemies/sdk/runtime';
import { decideApproval } from '@/features/chat/runtime/decide-approval';

const status = (code: number) =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: code,
    data: {},
    statusText: '',
    headers: {},
    config: {} as never,
  });

beforeEach(() => {
  state.post.mockReset();
});

describe('decideApproval', () => {
  it('posts the decision to the request of that agent, with its ids escaped', async () => {
    state.post.mockResolvedValue({ status: 204 });
    await decideApproval('req/1', 'agent 1', 'allow');
    expect(state.post).toHaveBeenCalledExactlyOnceWith(
      '/agents/external/agent%201/approvals/req%2F1',
      {
        decision: 'allow',
      },
    );
  });

  it('sends a denial as a denial', async () => {
    state.post.mockResolvedValue({ status: 204 });
    await decideApproval('r-1', 'a-1', 'deny');
    expect(state.post).toHaveBeenCalledWith(expect.any(String), { decision: 'deny' });
  });

  it('says the question is no longer open on a 404', async () => {
    state.post.mockRejectedValue(status(404));
    await expect(decideApproval('r-1', 'a-1', 'allow')).rejects.toBeInstanceOf(
      ApprovalExpiredError,
    );
  });

  it('lets any other failure through, to be tried again', async () => {
    state.post.mockRejectedValue(status(500));
    await expect(decideApproval('r-1', 'a-1', 'allow')).rejects.not.toBeInstanceOf(
      ApprovalExpiredError,
    );
    state.post.mockRejectedValue(new Error('network'));
    await expect(decideApproval('r-1', 'a-1', 'allow')).rejects.toThrow('network');
  });
});
