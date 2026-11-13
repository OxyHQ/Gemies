import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The web reads a gemie's Telegram photo from the avatar's SVG, never through Skia: even a lazy
 * `import('@shopify/react-native-skia')` is emitted by Metro as a chunk of the web export, and
 * `scripts/check-web-bundle.mjs` fails the deploy on it (canvaskit.wasm is not deployed). The
 * native capture stays in `gemie-avatar-photo.tsx`.
 */
const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

describe("a gemie's Telegram photo on the web", () => {
  it.each(['gemie-avatar-photo.web.tsx', 'gemie-avatar-photo-host.tsx'])(
    '%s reaches no Skia',
    (file) => {
      expect(source(file)).not.toMatch(/['"]@shopify\/react-native-skia/);
    },
  );

  it('keeps the Skia capture on the native path only', () => {
    expect(source('gemie-avatar-photo.tsx')).toMatch(/import\('@shopify\/react-native-skia'\)/);
  });
});
