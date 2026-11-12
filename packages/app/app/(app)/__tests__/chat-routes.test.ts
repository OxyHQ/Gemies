import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A chat screen has ONE header: the layout leaves the routes in `CHAT_ROUTES` bare, because they
 * compose their own `AiChatContainer`. A name there that is no route file is silently nothing, and
 * the screen it meant gets the shell's header on top of its own. That shipped: the home became the
 * chat with Alia and `/alia` was deleted, but the set still named `alia`, so `/` drew two menu
 * buttons. These read the sources, so they pin the set without rendering the shell.
 */
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const layout = readFileSync(at('../_layout.tsx'), 'utf8');
const names = [
  ...(layout.match(/const CHAT_ROUTES = new Set\(\[(.*?)\]\);/)?.[1] ?? '').matchAll(/'([^']+)'/g),
].map((match) => match[1] ?? '');

describe('the routes the layout leaves to draw their own chat', () => {
  it('include the home, which is the chat with Alia', () => {
    expect(names).toContain('index');
  });

  it.each(names)('%s is a route file', (name) => {
    expect(existsSync(at(`../${name}.tsx`))).toBe(true);
  });
});
