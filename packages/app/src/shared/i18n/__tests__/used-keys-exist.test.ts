import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';
import en from '@/shared/i18n/locales/en.json';
import es from '@/shared/i18n/locales/es.json';

/**
 * Every key the app asks for by name exists in both catalogs.
 *
 * A missing key does not throw: i18n-js renders the key's last segment, so the
 * person reads "title", "body", "decline" and "accept" on a toast. That shipped:
 * a 2026-09-25 cleanup removed the whole `models` namespace while the local
 * models invite still read `models.localInvite.*`, and nothing failed because no
 * test compared what the code asks for with what the catalogs hold. This one does,
 * for every literal `t('a.b')` in the app's source.
 */

type Catalog = { [key: string]: string | Catalog };

/** The keys a literal can name: leaves, plural groups and the namespaces above them. */
function namedKeys(catalog: Catalog, prefix = '', out = new Set<string>()): Set<string> {
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out.add(path);
    if (typeof value !== 'string') namedKeys(value, path, out);
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const LITERAL_KEY = /\bt\(\s*['"]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)['"]/g;

const files = ['src', 'app'].flatMap((dir) => sourceFiles(join(APP_ROOT, dir)));
const used = files.flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(LITERAL_KEY)].map((match) => ({
    key: match[1]!,
    file: relative(APP_ROOT, file),
  })),
);

describe('the keys the app names', () => {
  it('read a real census, not an empty one', () => {
    expect(files.length).toBeGreaterThan(250);
    // 919 when the shows screens left (generated podcasts are Syra's); a floor, not the count.
    expect(used.length).toBeGreaterThan(800);
    expect(used.map((use) => use.key)).toContain('models.localInvite.title');
  });

  it.each([
    ['en', en],
    ['es', es],
  ])('all exist in %s.json', (_lang, catalog) => {
    const keys = namedKeys(catalog as Catalog);
    const missing = used
      .filter((use) => !keys.has(use.key))
      .map((use) => `${use.key} (${use.file})`);
    expect([...new Set(missing)]).toEqual([]);
  });
});
