/**
 * The web frontends deploy to Gemies' own Workers and hostnames, never to Alia's.
 *
 * This repository was created from OxyHQ/Alia with its whole history (ADR 0034). Alia still
 * deploys its web app (`alia-app` on `alia.onl`) and Canvas (`alia-canvas` on `canvas.alia.onl`)
 * from THAT repository. `wrangler deploy` replaces whatever Worker has the configured name and
 * claims whatever custom domain is configured, so a `wrangler.toml` here that named either of
 * Alia's would overwrite Alia's production web app with this one, with no error from Cloudflare.
 *
 * So each config must name exactly the Worker and the custom domains listed below, and no Worker
 * name or route anywhere in the frontend configs may mention Alia's. Static: it reads the files
 * `deploy-frontends.yml` deploys from, in the CI job that installs nothing.
 */

import { readFileSync } from 'node:fs';

const EXPECTED = [
  {
    file: 'packages/app/wrangler.toml',
    name: 'gemies-app',
    routes: ['gemies.ai', 'www.gemies.ai'],
  },
  {
    file: 'packages/alia-canvas/wrangler.toml',
    name: 'gemies-canvas',
    routes: ['canvas.gemies.ai'],
  },
];

/** Alia's production Workers and hostnames, deployed from OxyHQ/Alia. */
const FORBIDDEN = /alia-app|alia-canvas|alia\.onl/;

/** The TOML lines that carry meaning: comments and blank lines dropped. */
function significantLines(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

const failures = [];

for (const { file, name, routes } of EXPECTED) {
  const lines = significantLines(readFileSync(file, 'utf8'));
  const names = lines
    .map((line) => /^name\s*=\s*"([^"]*)"$/.exec(line)?.[1])
    .filter((value) => value !== undefined);
  if (names.length !== 1 || names[0] !== name) {
    failures.push(`${file}: the Worker name is ${JSON.stringify(names)}, expected ["${name}"].`);
  }
  const patterns = lines
    .map((line) => /^pattern\s*=\s*"([^"]*)"$/.exec(line)?.[1])
    .filter((value) => value !== undefined);
  if (JSON.stringify([...patterns].sort()) !== JSON.stringify([...routes].sort())) {
    failures.push(
      `${file}: the routes are ${JSON.stringify(patterns)}, expected ${JSON.stringify(routes)}.`,
    );
  }
  const customDomains = lines.filter((line) => /^custom_domain\s*=\s*true$/.test(line)).length;
  if (customDomains !== routes.length) {
    failures.push(
      `${file}: ${customDomains} of ${routes.length} routes are custom domains; every route must be.`,
    );
  }
  for (const line of lines) {
    if (FORBIDDEN.test(line)) {
      failures.push(`${file}: \`${line}\` names one of Alia's Workers or hostnames.`);
    }
  }
}

if (failures.length > 0) {
  console.error('check-frontend-worker-targets: the frontends would deploy somewhere else:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nOxyHQ/Alia deploys alia-app (alia.onl) and alia-canvas (canvas.alia.onl); never name them here.',
  );
  process.exit(1);
}

console.log(
  `check-frontend-worker-targets: ${EXPECTED.map((entry) => `${entry.name} → ${entry.routes.join(', ')}`).join('; ')}.`,
);
