import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPY_EN } from '../../../src/lib/copy-en';
import { COPY_ES } from '../../../src/lib/copy-es';
import { messageFailureOf } from '../../../src/runtime/thread/message-failure';

/**
 * A scheduled reply that ended without an answer is a typed failure the thread draws in the
 * reader's language. The gemie's message used to be the run's status line, "Token budget
 * exhausted. Partial progress was made." (2026-11-14). The row is a source gate, as
 * `ThreadRow.bubbles` is.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const row = readFileSync(join(HERE, '../../../src/components/thread/ThreadRow.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('a message that is a failure', () => {
  it('is read from its one failure part, and nothing else is one', () => {
    expect(messageFailureOf([{ type: 'failure', code: 'task_unfinished' }])).toBe(
      'task_unfinished',
    );
    expect(messageFailureOf('Token budget exhausted. Partial progress was made.')).toBeNull();
    expect(messageFailureOf([{ type: 'failure', code: 'something_else' }])).toBeNull();
    expect(messageFailureOf([{ type: 'text', text: 'Hola' }])).toBeNull();
  });

  it('is drawn with the app’s own words, in every language the SDK speaks', () => {
    expect(row).toMatch(
      /agent && messageFailureOf\(message\.content\) === 'task_unfinished' \? \(\s*<Text[^>]*>\s*\{t\('chat\.taskUnfinished', \{ name: agent\.name \}\)\}/,
    );
    expect(COPY_EN['chat.taskUnfinished']).toBe("%{name} couldn't finish this task.");
    expect(COPY_ES['chat.taskUnfinished']).toBe('%{name} no ha podido terminar esta tarea.');
  });
});
