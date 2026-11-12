/**
 * A task that names no gemie is Alia's (ADR 0034 §2, §4): `fixed` on her gemie, never a separate
 * `alia` actor mode, which no longer exists anywhere — not on the wire, not in the table.
 */
import { describe, expect, it } from 'vitest';
import { ALIA_GEMIE_ID } from '../../domain/alia-gemie.js';
import { AUTOMATION_ACTOR_MODES } from '../../db/schema/agency.js';
import { createAutomationSchema } from '../structured-automation-creation.js';

const task = {
  objective: 'Tell me the news every morning',
  trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'Europe/Madrid' },
  dataFlow: { sources: [], destinations: [] },
  maximumAutonomy: 'autonomous',
};

describe('the responsible actor of a task', () => {
  it('is Alia’s gemie, fixed, when none is named', () => {
    expect(createAutomationSchema.parse(task).actorSelection).toEqual({
      mode: 'fixed',
      agentId: ALIA_GEMIE_ID,
    });
  });

  it('refuses the retired `alia` actor mode', () => {
    expect(
      createAutomationSchema.safeParse({ ...task, actorSelection: { mode: 'alia' } }).success,
    ).toBe(false);
    expect(AUTOMATION_ACTOR_MODES).toEqual(['fixed', 'automatic']);
  });
});
