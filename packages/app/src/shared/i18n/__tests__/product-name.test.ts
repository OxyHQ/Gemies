import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/shared/i18n/locales/en.json';
import es from '@/shared/i18n/locales/es.json';

/**
 * The product is Gemies; Alia is one gemie in it (ADR 0034).
 *
 * The app was copied from Alia's, and its copy kept calling the product "Alia": page titles
 * ("Shared conversation | Alia", "Download Alia"), invitations, sign-out, credits. Each string
 * that still says "Alia" is listed below, by key, because there it is the gemie herself (what she
 * remembers, answers, writes; her computer, her language, her intro). A new string naming Alia
 * fails here until it is either about her, and listed, or says Gemies. The Alia app
 * (OxyHQ/Alia) is a different product and keeps its name.
 */
const ALIA_THE_GEMIE = new Set([
  'agents.capabilityFamily.memory.description',
  'agents.editor.work.computerAlia',
  'agents.editor.work.computerNote',
  'authorize.returnToApp',
  'chat.turnFailed',
  'chat.turnInterrupted',
  'chatHeader.shareCopiedDescription',
  'chatHeader.shareText',
  'gemie.connectors.connected.description',
  'gemies.metaDescription',
  'panel.emptyCanvas',
  'settings.aliaLanguage.description',
  'settings.aliaLanguage.title',
  'settings.assistant.memory.niloDescription',
  'settings.assistant.proactive.aliaEmailDescription',
  'settings.assistant.writingStyle.editDescription',
  'settings.assistant.writingStyle.resetDescription',
  'settings.memoryManagement.description',
  'settings.personalityStyle.description',
  'settings.personalityStyle.styles.alia.greeting',
  'settings.personalityStyle.styles.alia.name',
  'settings.responseLength.auto',
  'settings.responseLength.description',
  'settings.responseTone.description',
  'settings.subtitle',
  'settings.voicePreference.description',
  'sidebar.create.chatHint',
  'sidebar.responding',
  'skills.autoInvoke',
  'skills.autoInvokeHint',
  'skills.bodyHint',
  'skills.createSubtitle',
  'skills.descriptionHint',
  'skills.enabledHint',
  'skills.importSubtitle',
  'skills.nameHint',
  'skills.subtitle',
  'welcome.gemiesIntro.subtitle',
  'welcome.intro.headline',
]);

/** Source files where a bare `'Alia'` literal is her name: her sidebar row, her editor, her style. */
const ALIA_NAME_LITERAL_FILES = new Set([
  'src/features/agents/ui/edit/locked-gemie-editor.tsx',
  'src/features/settings/model/personality-styles.ts',
  'src/shell/sidebar-gemie-menu.tsx',
  'src/shell/sidebar.tsx',
]);

type Catalog = { [key: string]: string | Catalog };

function leaves(catalog: Catalog, prefix = ''): [string, string][] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof value === 'string' ? [[path, value] as [string, string]] : leaves(value, path);
  });
}

const APP_ROOT = join(__dirname, '../../../..');

/** Prose about Alia in a comment is not copy anybody reads. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('the product is called Gemies', () => {
  it.each([
    ['en', en],
    ['es', es],
  ])('in %s, only strings about Alia the gemie name her', (_language, catalog) => {
    const naming = leaves(catalog as Catalog)
      .filter(([, text]) => /\bAlia\b/.test(text))
      .map(([key]) => key);
    expect(naming.filter((key) => !ALIA_THE_GEMIE.has(key))).toEqual([]);
    // The list is kept exact: a key that no longer names her leaves it.
    expect([...ALIA_THE_GEMIE].filter((key) => !naming.includes(key))).toEqual([]);
  });

  it('names no title, header or plan "Alia" in the source outside her own files', () => {
    const files = [...sources(join(APP_ROOT, 'app')), ...sources(join(APP_ROOT, 'src'))];
    // Floor: both trees were read; a wrong root reads as clean.
    expect(files.length).toBeGreaterThan(250);
    const offenders = files
      .map((file) => relative(APP_ROOT, file))
      .filter((file) => !ALIA_NAME_LITERAL_FILES.has(file))
      .filter((file) =>
        /['"`]Alia\b[^'"`]*['"`]|title="Alia|<title>[^<]*Alia/.test(
          withoutComments(readFileSync(join(APP_ROOT, file), 'utf8')),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('says Gemies in what the browser shows before the app runs', () => {
    for (const file of ['public/manifest.json', 'public/sw.js', 'public/robots.txt']) {
      expect(readFileSync(join(APP_ROOT, file), 'utf8'), file).not.toMatch(/\bAlia\b/);
    }
  });
});
