import { describe, expect, it } from 'vitest';
import {
  validateObligationSelection,
  assertObligationBinding,
  type RoomObligation,
} from '../obligations.js';
import type { RoomSelectionInput, RoomDecision } from '../decision.js';

const input: RoomSelectionInput = {
  userId: 'u',
  conversationId: 'room',
  triggerId: 'p',
  lastSpeakerId: null,
  depth: 0,
  roster: ['a', 'b', 'c'].map((id) => ({
    info: { id, name: id, handle: id, color: null, character: null },
  })),
  rows: [
    {
      id: 'p',
      clientMessageId: 'p',
      role: 'user',
      agentName: null,
      content: 'A summarizes, then B titles it.',
    },
  ],
};
const assignments: RoomObligation[] = [
  {
    id: 'summary',
    recipientId: 'a',
    task: 'Summarize',
    dependsOn: [],
    state: 'pending',
    evidence: [],
  },
  {
    id: 'title',
    recipientId: 'b',
    task: 'Title the summary',
    dependsOn: ['summary'],
    state: 'pending',
    evidence: [],
  },
];
const speak = (agentId: string): RoomDecision => ({ action: 'speak', agentId, reason: 'directed' });
const idle: RoomDecision = { action: 'idle', agentId: null, reason: 'complete' };
const initial = () => validateObligationSelection(assignments, speak('a'), input).obligationPlan!;
const answered = (): RoomSelectionInput => ({
  ...input,
  obligationPlan: initial(),
  lastSpeakerId: 'a',
  rows: [
    ...input.rows,
    {
      id: 'a-reply',
      clientMessageId: 'a-reply',
      role: 'assistant',
      agentId: 'a',
      agentName: 'A',
      content: 'Sales stayed stable. Want more detail?',
    },
  ],
});
const afterSummary = () =>
  assignments.map((o) => ({
    ...o,
    dependsOn: [...o.dependsOn],
    evidence: o.id === 'summary' ? ['a-reply'] : [...o.evidence],
    state: o.id === 'summary' ? ('completed' as const) : o.state,
  }));

describe('source-bound explicit obligations', () => {
  it('does not let a clarification suspend another ready recipient', () => {
    const independent = assignments.map((o) => ({ ...o, dependsOn: [] }));
    expect(() =>
      validateObligationSelection(
        independent,
        { action: 'clarify', agentId: 'b', reason: 'ambiguous' },
        input,
      ),
    ).toThrow('another ready recipient');
    expect(
      validateObligationSelection(
        assignments,
        { action: 'clarify', agentId: 'a', reason: 'ambiguous' },
        input,
      ).action,
    ).toBe('clarify');
  });
  it('cannot complete a dependent task before its prerequisite, even with its own text', () => {
    const rows = [
      ...input.rows,
      {
        id: 'b-reply',
        clientMessageId: 'b-reply',
        role: 'assistant',
        agentId: 'b',
        agentName: 'B',
        content: 'A premature title',
      },
    ];
    const premature = assignments.map((o) =>
      o.recipientId === 'b' ? { ...o, state: 'completed', evidence: ['b-reply'] } : o,
    );
    expect(() => validateObligationSelection(premature, speak('a'), { ...input, rows })).toThrow(
      'before its dependencies',
    );
  });

  it('retains the original second assignment after an optional human-facing question', () => {
    const result = validateObligationSelection(afterSummary(), speak('b'), answered());
    expect(result.obligationPlan?.obligations[1]?.state).toBe('pending');
    expect(() => validateObligationSelection(afterSummary(), idle, answered())).toThrow(
      'ready assignments',
    );
  });
  it.each(['drop', 'recipient', 'task', 'dependency'] as const)(
    'rejects %s changes after admission',
    (change) => {
      const updates = afterSummary();
      if (change === 'drop') updates.pop();
      if (change === 'recipient') updates[1]!.recipientId = 'c';
      if (change === 'task') updates[1]!.task = 'Different task';
      if (change === 'dependency') updates[1]!.dependsOn = [];
      expect(() => validateObligationSelection(updates, idle, answered())).toThrow();
    },
  );
  it('does not accept another actor’s answer as the assigned actor’s completion', () => {
    const updates = afterSummary().map((o) => ({
      ...o,
      state: 'completed',
      evidence: ['a-reply'],
    }));
    expect(() => validateObligationSelection(updates, idle, answered())).toThrow(
      'recipient evidence',
    );
  });
  it('does not accept person text or fabricated evidence as completion', () => {
    for (const evidence of ['p', 'missing'])
      expect(() =>
        validateObligationSelection(
          [{ ...assignments[0]!, state: 'completed', evidence: [evidence] }],
          idle,
          input,
        ),
      ).toThrow('recipient evidence');
  });
  it('requires a clean completion of this request, even when its target is historical', () => {
    const old = {
      ...input.rows[0]!,
      id: 'old',
      clientMessageId: 'old',
      reactionEntries: [{ emoji: '👍', author: { kind: 'agent' as const, id: 'a', name: 'A' } }],
    };
    const context = { ...input, rows: [old, ...input.rows] };
    expect(() =>
      validateObligationSelection(
        [{ ...assignments[0]!, state: 'completed', evidence: ['old'] }],
        idle,
        context,
      ),
    ).toThrow('recipient evidence');
    const current = {
      ...context,
      reactionContributions: [
        {
          id: 'current-completion',
          actorId: 'a',
          mutations: [{ messageId: 'old', emoji: '👍', active: true }],
        },
      ],
    };
    const done = [{ ...assignments[0]!, state: 'completed', evidence: ['current-completion'] }];
    expect(validateObligationSelection(done, idle, current).action).toBe('idle');
    expect(() =>
      validateObligationSelection([{ ...done[0], recipientId: 'b' }], idle, current),
    ).toThrow('recipient evidence');
    expect(() => validateObligationSelection(done, idle, context)).toThrow('recipient evidence');
  });
  it('a waiting assignment cannot block an independent original assignment', () => {
    const independent = [assignments[0]!, { ...assignments[1]!, dependsOn: [] }];
    const plan = validateObligationSelection(independent, speak('a'), input).obligationPlan;
    const context = { ...answered(), obligationPlan: plan };
    const waiting = [
      { ...independent[0]!, state: 'waiting_person', evidence: ['a-reply'] },
      independent[1]!,
    ];
    expect(() => validateObligationSelection(waiting, idle, context)).toThrow('ready assignments');
    expect(validateObligationSelection(waiting, speak('b'), context).agentId).toBe('b');
  });
  it('waiting dependencies remain unfinished, separately from completion', () => {
    const waiting = [
      { ...assignments[0]!, state: 'waiting_person', evidence: ['a-reply'] },
      assignments[1]!,
    ];
    const result = validateObligationSelection(waiting, idle, answered());
    expect(result.waitingForPerson).toBe(true);
    expect(result.obligationPlan?.obligations[1]?.state).toBe('pending');
    expect(() => validateObligationSelection(waiting, speak('b'), answered())).toThrow('no ready');
  });
  it('a sufficient own answer for each assignment permits completion', () => {
    const context = {
      ...answered(),
      rows: [
        ...answered().rows,
        {
          id: 'b-reply',
          clientMessageId: 'b-reply',
          role: 'assistant',
          agentId: 'b',
          agentName: 'B',
          content: 'Stable sales, broader reach',
        },
      ],
    };
    const updates = afterSummary().map((o) =>
      o.id === 'title' ? { ...o, state: 'completed', evidence: ['b-reply'] } : o,
    );
    expect(validateObligationSelection(updates, idle, context).waitingForPerson).toBeUndefined();
  });
  it('binds both human content and admitted identities, not their display names', () => {
    const plan = initial();
    expect(() =>
      assertObligationBinding(plan, {
        ...input,
        rows: [{ ...input.rows[0]!, content: 'Changed' }],
      }),
    ).toThrow();
    expect(() => assertObligationBinding(plan, { ...input, triggerId: 'new' })).toThrow();
    expect(() =>
      assertObligationBinding(plan, { ...input, roster: input.roster.slice(1) }),
    ).toThrow();
    expect(() =>
      assertObligationBinding(plan, {
        ...input,
        roster: input.roster.map((m) => ({
          ...m,
          available: false,
          info: { ...m.info, name: 'renamed' },
        })),
      }),
    ).not.toThrow();
  });
  it('rejects unknown recipients, dependency cycles and duplicate ids', () => {
    const variants = [
      [{ ...assignments[0]!, recipientId: 'outsider' }],
      [{ ...assignments[0]!, dependsOn: ['title'] }, assignments[1]!],
      [assignments[0]!, assignments[0]!],
    ];
    for (const v of variants)
      expect(() => validateObligationSelection(v, speak('a'), input)).toThrow();
  });
  it('open requests do not manufacture a compulsory member round', () => {
    expect(validateObligationSelection([], idle, input).obligationPlan?.obligations).toEqual([]);
    expect(
      validateObligationSelection(
        [],
        { action: 'speak', agentId: 'c', reason: 'contribution' },
        input,
      ).agentId,
    ).toBe('c');
    expect(() =>
      validateObligationSelection(
        assignments,
        { action: 'speak', agentId: 'c', reason: 'contribution' },
        input,
      ),
    ).toThrow();
  });
});
