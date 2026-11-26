import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSISTED_DATA_VERSION } from '@/shared/api/persisted-data-version';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * The app's account data on disk (`persist: { version: PERSISTED_DATA_VERSION }` in the account's
 * bloom-data store) is drawn before it is refreshed: read in a new shape, an old row would crash
 * the screen (Inbox shipped exactly that when a hand-kept version was forgotten). The store drops a
 * type's rows when its version changes, so the version is not kept by memory: this fingerprints the
 * type declarations each persisted answer is read with, and fails when they change until the
 * version is bumped and the fingerprint below is updated with it.
 *
 * Best effort by construction: it sees the files listed here. A new persisted answer must list its
 * own (the second test), and a type a listed file imports from elsewhere must be listed too. The
 * SDK's conversations, collections, profiles and threads are versioned by the SDK.
 */
const SHAPES: Record<string, string[]> = {
  'alia.my-agents': ['src/shared/contracts/agents.ts'],
  'alia.spaces': ['src/shared/contracts/spaces.ts'],
};

/** Bump both together: `PERSISTED_DATA_VERSION`, and this to what the failure prints. */
const RECORDED = { version: 1, fingerprint: 'c2fcde0eb8cdb550' };

/** Every file under `src` that declares a persisted answer: `answerSource('<type>', { … persist`. */
function persistedTypes(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(path, 'utf8');
        const call = /answerSource\(\s*'([^']+)',\s*\{([\s\S]*?)\n\}\);/g;
        for (let match = call.exec(source); match; match = call.exec(source)) {
          if (/^\s*persist:/m.test(match[2] ?? ''))
            found.push(match[1] ?? relative(APP_ROOT, path));
        }
      }
    }
  };
  walk(join(APP_ROOT, 'src'));
  return found.sort();
}

/** Every `export interface|type` declaration, and every exported `const` that shapes the blob. */
function declarations(source: string): string[] {
  const found: string[] = [];
  const start = /^export (?:interface|type|const) \w+/gm;
  for (let match = start.exec(source); match; match = start.exec(source)) {
    let depth = 0;
    let i = match.index;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
      else if (c === '}' || c === ')' || c === ']' || c === '>') depth--;
      else if (depth <= 0 && (c === ';' || (c === '\n' && source[i - 1] === '}'))) break;
    }
    // Only declarations: a function's body is behaviour, not shape.
    const text = source.slice(match.index, i + 1);
    if (/^export const \w+ = (?:\(|async|function)/.test(text)) continue;
    found.push(text.replace(/\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, ' '));
  }
  return found;
}

function fingerprint(): string {
  const files = [...new Set(Object.values(SHAPES).flat())].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    for (const declaration of declarations(readFileSync(join(APP_ROOT, file), 'utf8'))) {
      hash.update(declaration);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

describe('the persisted data version', () => {
  it('moves with the shape of what is persisted', () => {
    const now = fingerprint();
    expect(
      { version: PERSISTED_DATA_VERSION, fingerprint: now },
      `A persisted type changed: bump PERSISTED_DATA_VERSION and set RECORDED to { version: ${
        PERSISTED_DATA_VERSION + 1
      }, fingerprint: '${now}' } (a version bump without a shape change is fine too).`,
    ).toEqual(RECORDED);
  });

  it('knows where every persisted answer is typed', () => {
    expect(persistedTypes()).toEqual(Object.keys(SHAPES).sort());
  });

  it('reads a declaration and ignores comments (the control)', () => {
    const one = declarations('/** a */\nexport interface A {\n  b: string; // c\n}\n');
    const two = declarations('export interface A {\n  b: string;\n}\n');
    expect(one).toEqual(two);
    expect(declarations('export interface A { b: number }\n')).not.toEqual(two);
  });
});
