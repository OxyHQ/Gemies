import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandHome, resolveSessionCwd } from '../roots.js';

let base: string;
let allowed: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gemies-roots-'));
  allowed = join(base, 'code');
  outside = join(base, 'secrets');
  mkdirSync(join(allowed, 'app', 'src'), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('resolveSessionCwd', () => {
  it('accepts a root and anything under it', () => {
    for (const folder of [allowed, join(allowed, 'app'), join(allowed, 'app', 'src')]) {
      const result = resolveSessionCwd(folder, [allowed]);
      expect(result.ok).toBe(true);
    }
  });

  it('refuses a folder outside every root, and tells how to allow it', () => {
    const result = resolveSessionCwd(outside, [allowed]);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining(`gemies allow ${outside}`),
    });
  });

  it('refuses a sibling whose name starts like a root, and a path that climbs out with ..', () => {
    const sibling = join(base, 'code-evil');
    mkdirSync(sibling);
    expect(resolveSessionCwd(sibling, [allowed]).ok).toBe(false);
    expect(resolveSessionCwd(join(allowed, '..', 'secrets'), [allowed]).ok).toBe(false);
  });

  it('follows symlinks, so a link inside a root cannot lead out of it', () => {
    symlinkSync(outside, join(allowed, 'escape'));
    expect(resolveSessionCwd(join(allowed, 'escape'), [allowed]).ok).toBe(false);
  });

  it('refuses a relative path, a missing folder and a file', () => {
    expect(resolveSessionCwd('code/app', [allowed]).ok).toBe(false);
    expect(resolveSessionCwd(join(allowed, 'nope'), [allowed])).toMatchObject({
      ok: false,
      message: expect.stringContaining('does not exist'),
    });
    writeFileSync(join(allowed, 'file.txt'), 'x');
    expect(resolveSessionCwd(join(allowed, 'file.txt'), [allowed]).ok).toBe(false);
  });

  it('allows nothing when there are no roots', () => {
    expect(resolveSessionCwd(allowed, []).ok).toBe(false);
  });

  it('reads ~ as the home folder, on both sides', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/code', '/h')).toBe(join('/h', 'code'));
    expect(expandHome('~other', '/h')).toBe('~other');
    const result = resolveSessionCwd('~/app', ['~'], allowed);
    expect(result.ok).toBe(true);
  });
});
