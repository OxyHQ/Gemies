/**
 * When the connector catalogue's logos are read again, and on which task.
 *
 * Leader-gated through the same lease the skill catalogue uses: one task reads
 * the providers' sites and writes the rows every account reads. The first run
 * waits a minute after the task wins the lease, so a deploy's warm-up is not
 * spent on it; `refreshRegistryLogos` skips entries read in the last week, so a
 * daily run fetches only what is due.
 */

import { getDb } from '../db/index.js';
import { refreshRegistryLogos } from './connector-logos.js';
import { startLeaderElection, type LeaderElectionHandle } from './leader-election.js';
import { log } from './logger.js';

const LEASE = 'connector-logo-refresh';
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

let election: LeaderElectionHandle | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;

async function runOnce(): Promise<void> {
  // Never throws into a timer: a logo that cannot be read leaves a monogram.
  await refreshRegistryLogos(getDb()).catch((err) =>
    log.general.error({ err }, 'Connector logo refresh failed'),
  );
}

function clearTimers(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}

export function startConnectorLogoRefresh(): void {
  if (election) return;
  election = startLeaderElection(LEASE, {
    onElected: () => {
      firstRun = setTimeout(() => void runOnce(), FIRST_RUN_DELAY_MS);
      timer = setInterval(() => void runOnce(), INTERVAL_MS);
    },
    onDemoted: clearTimers,
  });
}

export async function stopConnectorLogoRefresh(): Promise<void> {
  clearTimers();
  await election?.stop();
  election = null;
}
