/** Own voice and dictation share Kaana's canonical Oxy workload transport. */
import { kaanaForOxyService } from '@kaana.ai/sdk/server';
import { Kaana } from '@kaana.ai/sdk';
import { oxy } from '../oxy.js';
import type { KaanaClient } from './port.js';

let testClient: KaanaClient | null | undefined;

/** One immutable inference attribution per call; it grants no user-data authority. */
export function getKaanaClient(accountId: string): KaanaClient | null {
  if (testClient !== undefined) return testClient;
  return kaanaForOxyService(oxy, { attribution: { accountId } });
}

/** Text/speech inference goes directly to Kaana; Oxy supplies workload identity only. */
export function getHostedKaanaClient(accountId?: string | null, machineCredential?: string) {
  // Only admitMachineTurn's verified external key reaches this argument. Keep its
  // payer; never substitute the Gemies workload or forward an audience-bound JWT.
  if (machineCredential !== undefined) {
    if (!machineCredential.startsWith('oxy_sk_'))
      throw new Error('A verified inference machine credential is required');
    return new Kaana({ credential: machineCredential, maxRetries: 0 });
  }
  // Existing transport-retry owns network replay, with one key and no retry after
  // output. Disable SDK retries so the two layers do not multiply attempts.
  return kaanaForOxyService(oxy, {
    ...(accountId ? { attribution: { accountId } } : {}),
    maxRetries: 0,
  });
}

export function disposeHostedKaanaClient(client: Kaana) {
  if ('dispose' in client && typeof client.dispose === 'function') client.dispose();
}

/** Test seam: install the Kaana test client, or restore the production factory. */
export function setKaanaClientForTests(client: KaanaClient | null | undefined): void {
  testClient = client;
}
