import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No server path invents a sampling temperature.
 *
 * Which model answers is Oxy's power-tier choice, not the caller's, and the
 * reasoning models (Claude Sonnet 5, GPT-5.6, Gemini 3.7…) take no
 * temperature: Kaana routes with `require_parameters`, so a turn that sends one
 * finds no route and fails (`invalid_request`, `param: sampling.temperature`).
 * On 2026-11-14 that was every Telegram gemie-bot turn: the bot answered "Sorry,
 * something went wrong" to every message. A temperature reaches a model only
 * when a client asked for it (`lib/chat/model-config.ts`), never as a literal
 * in our own code.
 */

const PACKAGES = path.resolve(import.meta.dirname, '../../..');
const TREES = ['api/src', 'integrations/src', 'app/src'].map((tree) => path.join(PACKAGES, tree));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const LITERAL_TEMPERATURE = /\btemperature:\s*[0-9.]+\s*[,}]/;

describe('no invented sampling temperature', () => {
  const files = TREES.flatMap(sources);

  it('reads the source trees at all', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(LITERAL_TEMPERATURE.test('      temperature: 0.7,')).toBe(true);
  });

  it('sends a temperature only when a client asked for one', () => {
    const offences = files.filter((file) =>
      LITERAL_TEMPERATURE.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offences.map((file) => path.relative(PACKAGES, file))).toEqual([]);
  });
});
