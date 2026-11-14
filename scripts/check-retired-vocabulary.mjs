/**
 * Retired vocabulary cannot return.
 *
 * Three retirements, each a clean cut with no compatibility code, so any trace of
 * them in the tree is either dead code or a lane coming back:
 *
 *  1. The retired product routes (`<kaana|alia>-lite`, `<kaana|alia>-v1-*`).
 *  2. The native-product-agent lane (ADR 0020 §8): its manifest and bootstrap,
 *     requester assertions, the internal MCP pilot flag, the two delegation
 *     tools `consultAgent` replaced, the negotiated stream features, and an
 *     application binding on an agent (ADR 0021 keeps it deleted: where an
 *     agent opens is Oxy's fact, read live, never an Alia column).
 *  3. Generated podcasts ("shows", 2026-11-14): podcast generation belongs to
 *     Syra, which a gemie reaches through the Syra connector. Their tables,
 *     routes, modules, realtime event, variables and Syra SDK cannot return.
 *     The one survivor is the release-only Oxy file entity class in
 *     `domain/oxy-files.ts`, allowed exactly once until the outbox has
 *     released it.
 *
 * Records of the past keep their words: ADRs, audits, migration inventories,
 * changelogs and applied migrations are history, not code. Every pattern is
 * spelled in pieces so this file does not match itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n');

const SELF = 'scripts/check-retired-vocabulary.mjs';

const immutableMigration = /^packages\/api\/drizzle\/(?:meta\/)?00(?:[0-5][0-9]|6[01])_/;
const retiredProductRoutes = new RegExp(
  `(?:${'kaana'}|${'alia'})-(?:lite|v1(?:-[a-z0-9-]+)?)`,
  'g',
);

/** History that names the lane on purpose. */
const laneHistory = [
  /^docs\/adr\//,
  /^docs\/audits\//,
  /^docs\/migration\//,
  /(?:^|\/)CHANGELOG\.md$/,
  /^packages\/api\/drizzle\//,
];
const retiredLane = new RegExp(
  [
    `native-${'product-agent'}`,
    `Requester${'Assertion'}`,
    `requester-${'assertion'}`,
    `ALIA_INTERNAL_${'MCP_PILOT'}`,
    `\\bask${'Agent'}\\b`,
    `\\bdelegateTo${'Agent'}\\b`,
    `\\bstream${'Features'}\\b`,
  ].join('|'),
  'g',
);

const retiredShows = new RegExp(
  [
    `show_${'(?:series|episodes|preferences)'}`,
    `[sS]how${'(?:Series|Episodes?)'}\\b`,
    `lib/${'show/'}`,
    `db/${'shows/'}`,
    `schema/${'shows'}`,
    `features/${'shows'}`,
    `routes/${'shows'}`,
    `${'shows'}\\.mdx`,
    `show[.:]${'progress'}`,
    `SYRA_${'(?:API_URL|COVER_FILE_IDS)'}`,
    `@syra\\.fm/${'sdk'}`,
    `['"]/${'shows'}\\b`,
    `/${'shows'}/(?:series|episodes|voices|preferences)`,
  ].join('|'),
  'g',
);

/**
 * The Oxy file entity class podcast covers were referenced under: the outbox
 * still admits it, so the releases migration 0170 enqueued can be delivered,
 * and nothing else may name it. Exact, so it leaves in a visible edit.
 */
const releaseOnlyEntityClass = {
  file: 'packages/api/src/domain/oxy-files.ts',
  match: `show_${'series'}`,
  count: 1,
};

/** What an agent is, on the server and on the wire: no application binding. */
const agentSchemas = [
  'packages/api/src/db/schema/agents.ts',
  'packages/api/src/db/agents/agentRepository.ts',
  'packages/app/src/shared/contracts/agents.ts',
];
const applicationBinding = new RegExp(`application${'Id'}|application${'_id'}`, 'g');

const failures = [];

/**
 * A deploy's removal list names what it strips from the live task definition,
 * because the deploy copies live configuration forward: the retired variable
 * must be spelled there for it to leave production at all.
 */
const removalList = /TASK_CONFIGURATION_REMOVALS_JSON/;

function report(file, source, pattern, why) {
  const lines = source.split('\n');
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split('\n').length;
    if (removalList.test(lines[line - 1] ?? '')) continue;
    failures.push(`${file}:${line}: ${match[0]} (${why})`);
  }
}

for (const file of tracked) {
  if (file === SELF) continue;
  const url = new URL(file, root);
  // `git ls-files --cached` also reports a tracked file deleted in the current
  // change. A deletion cannot introduce retired vocabulary.
  if (!existsSync(url)) continue;
  const source = readFileSync(url, 'utf8');
  if (!immutableMigration.test(file)) {
    report(file, source, retiredProductRoutes, 'retired product route');
  }
  if (!laneHistory.some((history) => history.test(file))) {
    report(file, source, retiredLane, 'retired native-product-agent lane, ADR 0020 §8');
  }
  if (!laneHistory.some((history) => history.test(file))) {
    const why = 'retired generated podcasts: they are Syra’s';
    if (file === releaseOnlyEntityClass.file) {
      const found = source.split(releaseOnlyEntityClass.match).length - 1;
      if (found !== releaseOnlyEntityClass.count) {
        failures.push(
          `${file}: names ${releaseOnlyEntityClass.match} ${found} times, expected ${releaseOnlyEntityClass.count} (the release-only entity class)`,
        );
      }
      report(file, source.replaceAll(releaseOnlyEntityClass.match, ''), retiredShows, why);
    } else {
      report(file, source, retiredShows, why);
    }
  }
  if (agentSchemas.includes(file)) {
    report(file, source, applicationBinding, 'an agent has no application binding, ADR 0021');
  }
}

for (const file of agentSchemas) {
  if (!existsSync(new URL(file, root))) {
    failures.push(`${file}: missing — the application-binding check would look at nothing`);
  }
}

if (failures.length > 0) {
  console.error('Retired vocabulary found:\n' + failures.join('\n'));
  process.exit(1);
}

console.log(`retired-vocabulary: OK — ${tracked.length} tracked files checked`);
