/**
 * The connectors store's upkeep, and on which task it runs.
 *
 * One leader-gated job (its own lease, like the skill catalogue's sync): it writes rows every
 * account reads and reaches hundreds of outside servers, so exactly one task does it. Every hour:
 *
 *  1. **Sync** the official MCP Registry, when the last complete pass is older than
 *     `SYNC_EVERY_MS` and the registry did not ask to wait (`sync.ts`).
 *  2. **Check health** of the synced servers that are due, a bounded round (`health.ts`).
 *  3. **Keep logos** of every offered entry, curated and synced, a bounded round
 *     (`connector-logos.ts`).
 *
 * Each step is allowed to fail without stopping the next, and nothing throws into the timer. The
 * first run waits a few minutes after the task wins the lease, so a deploy's warm-up is not spent on
 * it.
 *
 * Not the trigger engine: that schedules people's automations (model runs billed to them); this is
 * the service's own upkeep, like the skill catalogue's sync.
 */

import { getDb } from '../../db/index.js';
import { getCatalogueSyncState } from '../../db/integrations/mcpCatalogueRepository.js';
import { refreshCatalogueLogos } from '../connector-logos.js';
import { startLeaderElection, type LeaderElectionHandle } from '../leader-election.js';
import { log } from '../logger.js';
import { catalogueLogoSubjects, invalidateCatalogue } from './catalogue.js';
import { checkCatalogueHealth } from './health.js';
import { syncConnectorCatalogue } from './sync.js';

const LEASE = 'connector-catalogue';
const TICK_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;
/** How old the last complete pass may be before the registry is read again. */
const SYNC_EVERY_MS = 12 * 60 * 60 * 1000;

let election: LeaderElectionHandle | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** One round of upkeep. Exported for an operator's one-off run and for tests. */
export async function runConnectorCatalogueUpkeep(now = new Date()): Promise<void> {
  const db = getDb();
  try {
    const state = await getCatalogueSyncState(db, 'mcp_registry');
    const last = state?.lastSuccessAt?.getTime() ?? 0;
    if (now.getTime() - last >= SYNC_EVERY_MS) await syncConnectorCatalogue(db, { now });
  } catch (err: unknown) {
    log.general.error({ err }, 'Connector catalogue sync failed');
  }
  try {
    const health = await checkCatalogueHealth(db);
    if (health.checked) log.general.info({ health }, 'Connector catalogue health round');
  } catch (err: unknown) {
    log.general.error({ err }, 'Connector catalogue health round failed');
  }
  invalidateCatalogue();
  try {
    const logos = await refreshCatalogueLogos(db, await catalogueLogoSubjects(db), { now });
    if (logos.refreshed || logos.missing) log.general.info({ logos }, 'Connector logos read');
  } catch (err: unknown) {
    log.general.error({ err }, 'Connector logo round failed');
  }
}

async function tick(): Promise<void> {
  // A round may outlast an hour on a first sync; the next one waits for it.
  if (running) return;
  running = true;
  try {
    await runConnectorCatalogueUpkeep();
  } finally {
    running = false;
  }
}

function clearTimers(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}

export function startConnectorCatalogue(): void {
  if (election) return;
  election = startLeaderElection(LEASE, {
    onElected: () => {
      firstRun = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
      timer = setInterval(() => void tick(), TICK_MS);
    },
    onDemoted: clearTimers,
  });
}

export async function stopConnectorCatalogue(): Promise<void> {
  clearTimers();
  await election?.stop();
  election = null;
}
