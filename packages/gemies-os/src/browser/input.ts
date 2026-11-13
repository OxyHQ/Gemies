/**
 * The worker's side of the browser vocabulary (`@gemies/os-protocol`): how an
 * allowed key is spelled for Playwright, and what a receipt may say about an
 * input.
 *
 * There is deliberately no "evaluate this JavaScript", no selector, no file
 * chooser and no arbitrary key chord in the vocabulary. Each of those is a way
 * to act on a page that the screenshot does not show, and the screenshot is
 * what the owner watches. The page's text and its clickable elements are read
 * by a fixed function in the worker (`pool.ts`), never by caller-supplied code.
 * The control API refuses early and the worker refuses again — it is the last
 * line, and trusts nothing it is sent.
 */
import type { AllowedKey, BrowserInput } from '@gemies/os-protocol';

/** Playwright's spelling of an allowed key. */
export function playwrightKey(key: AllowedKey): string {
  return key === 'Space' ? ' ' : key;
}

/** What a receipt may say about an input: its kind, never the typed text. */
export function describeInput(input: BrowserInput): string {
  switch (input.type) {
    case 'click':
      return `click ${input.x},${input.y}`;
    case 'type':
      return `type ${input.text.length} characters`;
    case 'key':
      return `key ${input.key}`;
    case 'scroll':
      return `scroll ${input.deltaX ?? 0},${input.deltaY}`;
  }
}
