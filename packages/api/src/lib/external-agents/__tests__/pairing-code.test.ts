import { describe, expect, it } from 'vitest';
import {
  generatePairingCode,
  hashPairingCode,
  isWellFormedPairingCode,
  normalizePairingCode,
} from '../pairing-code.js';
import { buildInvitePrompt, inviteLocaleOf } from '../invite-prompt.js';
import { externalHistoryOf } from '../history.js';

describe('pairing codes', () => {
  it('generates XXXX-XXXX-XXXX-XXXX codes without look-alike symbols', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
      expect(isWellFormedPairingCode(code)).toBe(true);
    }
  });

  it('does not repeat across a thousand draws', () => {
    const seen = new Set(Array.from({ length: 1000 }, generatePairingCode));
    expect(seen.size).toBe(1000);
  });

  it('hashes the same for any spelling of one code', () => {
    const code = 'ABCD-EFGH-JKMN-PQRS';
    expect(hashPairingCode('abcd efgh jkmn pqrs')).toBe(hashPairingCode(code));
    expect(hashPairingCode('abcdefghjkmnpqrs')).toBe(hashPairingCode(code));
    expect(hashPairingCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPairingCode('ABCD-EFGH-JKMN-PQRT')).not.toBe(hashPairingCode(code));
  });

  it('rejects codes of the wrong length', () => {
    expect(isWellFormedPairingCode('ABCD-EFGH-JKMN')).toBe(false);
    expect(isWellFormedPairingCode('ABCD-EFGH-JKMN-PQRS')).toBe(true);
    expect(isWellFormedPairingCode('')).toBe(false);
    expect(normalizePairingCode('ab-cd')).toBe('ABCD');
  });
});

describe('invite prompt', () => {
  it('is self-sufficient: the code and one command, in either language, and no sign-in', () => {
    for (const locale of ['en', 'es'] as const) {
      const prompt = buildInvitePrompt({ code: 'ABCD-EFGH-JKMN-PQRS', locale });
      expect(prompt).toContain(
        'npx -y @alia-codea/cli@latest connect ABCD-EFGH-JKMN-PQRS --cli <claude|codex|opencode>',
      );
      expect(prompt).toContain('10');
      expect(prompt).toContain('"Connected"');
      expect(prompt).not.toMatch(/\bOxy\b|log ?in to|inicia(r)? sesión en Oxy/i);
      // It leaves a service behind, so the agent never waits for anybody to start it again.
      expect(prompt).toMatch(/service|servicio/);
      expect(prompt).not.toMatch(/background|segundo plano|If it stops|Si se detiene/);
    }
    expect(inviteLocaleOf('es-ES')).toBe('es');
    expect(inviteLocaleOf(undefined)).toBe('en');
  });
});

describe('externalHistoryOf', () => {
  it('splits the last user message from what came before', () => {
    const { task, history } = externalHistoryOf([
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
    ]);
    expect(task).toBe('fix the bug');
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });
});
