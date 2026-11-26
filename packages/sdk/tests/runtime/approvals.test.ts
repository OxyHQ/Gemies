import { describe, expect, it } from 'vitest';
import {
  type ApprovalEntry,
  parseApprovalRequest,
  parseApprovalResolved,
  stillPending,
  withApprovalOutcome,
  withApprovalRequest,
} from '../../src/runtime/approvals';

/**
 * A coding CLI asking its own user for permission (ADR 0043 §5): what a frame must hold to be a
 * question or an answer, and how the list of questions moves. A frame that is not one is dropped,
 * never half-shown.
 */

const request = {
  eventVersion: 1,
  requestId: 'r-1',
  agentId: 'a-1',
  tool: 'Bash',
  summary: 'bun test',
  expiresAt: '2026-11-26T12:00:00.000Z',
};

describe('parseApprovalRequest', () => {
  it('reads a question, with or without what it acts on', () => {
    expect(parseApprovalRequest(request)).toEqual({
      requestId: 'r-1',
      agentId: 'a-1',
      tool: 'Bash',
      summary: 'bun test',
      expiresAt: '2026-11-26T12:00:00.000Z',
    });
    const { summary: _summary, ...bare } = request;
    expect(parseApprovalRequest(bare)).not.toHaveProperty('summary');
  });

  it('drops a frame missing what the card needs, or with a deadline that is not a time', () => {
    for (const broken of [
      null,
      'junk',
      { ...request, requestId: '' },
      { ...request, agentId: undefined },
      { ...request, tool: 7 },
      { ...request, expiresAt: 'later' },
      { ...request, expiresAt: undefined },
    ]) {
      expect(parseApprovalRequest(broken)).toBeNull();
    }
  });

  it('shortens words that would not fit a card', () => {
    const long = parseApprovalRequest({
      ...request,
      tool: 'T'.repeat(300),
      summary: 's'.repeat(900),
    });
    expect(long?.tool).toHaveLength(80);
    expect(long?.summary).toHaveLength(200);
  });
});

describe('parseApprovalResolved', () => {
  it('reads the three ways a question ends', () => {
    for (const decision of ['allow', 'deny', 'expired'] as const) {
      expect(parseApprovalResolved({ requestId: 'r-1', decision })).toEqual({
        requestId: 'r-1',
        outcome: decision,
      });
    }
  });

  it('drops an answer that is not one of them', () => {
    expect(parseApprovalResolved({ requestId: 'r-1', decision: 'maybe' })).toBeNull();
    expect(parseApprovalResolved({ decision: 'allow' })).toBeNull();
    expect(parseApprovalResolved(undefined)).toBeNull();
  });
});

describe('the list of questions', () => {
  const entry = (id: string, outcome: ApprovalEntry['outcome'] = 'pending'): ApprovalEntry => ({
    requestId: id,
    agentId: 'a-1',
    tool: 'Bash',
    expiresAt: '2026-11-26T12:00:00.000Z',
    outcome,
  });

  it('adds a question once, waiting', () => {
    const once = withApprovalRequest([], parseApprovalRequest(request) as never);
    expect(once).toEqual([expect.objectContaining({ requestId: 'r-1', outcome: 'pending' })]);
    expect(withApprovalRequest(once, parseApprovalRequest(request) as never)).toHaveLength(1);
  });

  it('settles a waiting question, and the first answer stands', () => {
    const settled = withApprovalOutcome([entry('r-1'), entry('r-2')], 'r-1', 'allow');
    expect(settled.map((e) => e.outcome)).toEqual(['allow', 'pending']);
    expect(withApprovalOutcome(settled, 'r-1', 'deny')[0].outcome).toBe('allow');
    expect(withApprovalOutcome(settled, 'unknown', 'deny')).toEqual(settled);
  });

  it('keeps only the waiting ones for the next turn', () => {
    expect(
      stillPending([entry('a', 'allow'), entry('b'), entry('c', 'expired')]).map(
        (e) => e.requestId,
      ),
    ).toEqual(['b']);
  });
});
