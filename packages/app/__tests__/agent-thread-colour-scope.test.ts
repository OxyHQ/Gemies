import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The theme scope must not also lay the screen out.
 *
 * `BloomColorScope` renders its own wrapper unless told not to, and the two
 * platforms disagree about what that wrapper is. Native gives it
 * `{flex: 1}`; **web gives it a bare `<div style={vars}>` with no flex**, which
 * collapses to its content height inside a flex column and lifts the whole
 * conversation to the top of the panel.
 *
 * That shipped for an afternoon. The wrapper tinted everything correctly the
 * whole time — every colour I measured was right — so nothing that looked at
 * colour could see it, and only an agent WITH a colour showed it at all, since
 * `undefined` renders no wrapper.
 *
 * So the shape is asserted: `asChild`, over a child whose style fills (`flexGrow: 1`, what
 * `flex-1` drew).
 * Measured in Chromium at an 800px viewport, and this is what the numbers are:
 *
 *   | wrapper                | greeting top | composer top |
 *   |------------------------|--------------|--------------|
 *   | `asChild` + `flex-1`   | 360          | 732          |
 *   | no `asChild`           | 84           | 180          |
 *   | `asChild`, no `flex-1` | 84           | 180          |
 *
 * A browser is the only place those are visible, so what CI can hold is the
 * shape that produces them. It is narrow on purpose: a restructure that trips
 * it should be read, not silenced.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/features/agents/ui/agent-theme-scope.tsx', import.meta.url)),
  'utf8',
);

/** The `<BloomColorScope …>` opening tag and the element that follows it. */
function scopeAndChild(text: string): string {
  const start = text.indexOf('<BloomColorScope');
  if (start === -1) throw new Error('no <BloomColorScope> in the agent theme scope');
  const childEnd = text.indexOf('>', text.indexOf('<', text.indexOf('>', start) + 1));
  if (childEnd === -1) throw new Error('the <BloomColorScope> has no child element');
  return text.slice(start, childEnd + 1);
}

/** The scope's entry in the module's sheet (`scope: { … }`). */
function scopeEntry(text: string): string {
  const match = /\n {2}scope: \{[\s\S]*?\n {2}\},/.exec(text);
  if (!match) throw new Error('no `scope` entry in the agent theme scope’s sheet');
  return match[0];
}

/** Whether the scope's style fills the panel, as `flex-1` did. */
function fills(text: string): boolean {
  return /\bflexGrow: 1\b/.test(scopeEntry(text));
}

describe('the agent thread’s theme scope', () => {
  const opening = scopeAndChild(SOURCE);

  it('is read at all', () => {
    // The guard against asserting over an empty string: every check below would
    // pass on one, and would keep passing after the element was renamed away.
    // The account's colour: a preset key, or a hex colour as its seed.
    expect(opening).toContain('colorPreset=');
    expect(opening).toContain('seed=');
    expect(SOURCE.length).toBeGreaterThan(1000);
  });

  it('renders no wrapper of its own', () => {
    expect(opening).toContain('asChild');
  });

  it('hands `asChild` an element that fills the panel', () => {
    expect(opening).toContain('style={styles.scope}');
    expect(fills(SOURCE)).toBe(true);
  });

  /**
   * Break the scope element ONLY.
   *
   * Two earlier attempts at these controls broke something else: an exact class
   * string that stopped matching when `bg-background` joined the list, and then
   * a loose one that hit the FIRST `flex-1` in the file — which belongs to the
   * loading state twenty lines up, not to the scope. Both left the subject
   * untouched while reporting they had changed it. The fill is read from the
   * scope's own sheet entry, and broken there.
   */
  function withBrokenScope(edit: (opening: string) => string): string {
    const opening = scopeAndChild(SOURCE);
    return SOURCE.replace(opening, edit(opening));
  }

  it.each([
    ['without asChild', withBrokenScope((o) => o.replace(' asChild', ''))],
    ['without its style', withBrokenScope((o) => o.replace(' style={styles.scope}', ''))],
    [
      'without the fill',
      SOURCE.replace(scopeEntry(SOURCE), scopeEntry(SOURCE).replace(/flexGrow: 1,\s*/, '')),
    ],
  ])('would catch a scope %s', (_label, broken) => {
    // Every control, because each spelling of this bug produces the same
    // collapsed screen and any one alone would leave the others unguarded.
    expect(broken).not.toBe(SOURCE);

    const brokenOpening = scopeAndChild(broken);
    const sound =
      brokenOpening.includes('asChild') &&
      brokenOpening.includes('style={styles.scope}') &&
      fills(broken);

    expect(sound).toBe(false);
  });
});
