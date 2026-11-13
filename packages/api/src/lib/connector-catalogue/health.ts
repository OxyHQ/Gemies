/**
 * The synced servers' health check: a server is offered only once it answers, and stops being
 * offered when it stops answering.
 *
 * The check runs in integrations (`POST /mcp-catalogue/probe`, `packages/integrations/src/mcp/probe.ts`),
 * whose `connectorFetch` judges every address a connector reaches, for no account. It answers:
 *
 * - `open` — `initialize` and `tools/list` answered without a sign-in. The tools are judged here
 *   (`toolMetadataConcern`): their names and descriptions are the server's own text, and a server
 *   that hides characters in them, or writes instructions to the model, is not offered.
 * - `oauth` — it asks for a sign-in, with the authorization server's metadata readable. Offered only
 *   with Dynamic Client Registration; otherwise it `needs_provider_app` (a client its provider
 *   issues), which the store does not offer. Its tools are learnt only once a person connects it.
 * - `failed` — anything else. One failure is checked again within the hour; the second in a row
 *   makes it `failing` (not offered) until a later check passes.
 *
 * A probe that cannot be asked (integrations unreachable, or older than this route) stops the round
 * and changes nothing: the catalogue's health is never judged by our own outage.
 */

import { integrationsServiceFetch } from '../integrations-client.js';
import type { ApiDatabase } from '../../db/index.js';
import {
  type CatalogueHealthRecord,
  listCatalogueRowsDueForCheck,
  type McpCatalogueRow,
  recordCatalogueHealth,
} from '../../db/integrations/mcpCatalogueRepository.js';
import type { ConnectorIcon, McpServerTransport } from '../../db/schema/integrations.js';
import { storeServerLogo } from '../connector-logos.js';
import { log } from '../logger.js';
import { hasInvisibleText } from '../untrusted-text.js';

export type ProbeAnswer =
  | {
      outcome: 'open';
      tools: { name: string; description: string }[];
      server?: { icons?: ConnectorIcon[] };
    }
  | { outcome: 'oauth'; registration: boolean }
  | { outcome: 'failed'; reason: string };

export type Probe = (url: string, transport: McpServerTransport) => Promise<ProbeAnswer | null>;

const PROBE_REQUEST_TIMEOUT_MS = 40_000;
/** How many servers are checked at once: integrations' outbound connections stay few. */
const CONCURRENCY = 8;
const MAX_TOOLS = 500;
const MAX_TOOL_DESCRIPTION = 8_000;

/** Ask integrations to check one server; `null` when integrations cannot be asked. */
export const probeThroughIntegrations: Probe = async (url, transport) => {
  try {
    const response = await integrationsServiceFetch('/mcp-catalogue/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, transport }),
      signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as ProbeAnswer;
  } catch {
    return null;
  }
};

/**
 * What words a tool description must not carry: an instruction to the model rather than a
 * description for it. A legitimate tool describes what it does; it never tells the model to hide
 * things from the person or to disregard its instructions.
 */
const INSTRUCTION_TO_MODEL =
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|messages)|disregard (all |any )?(previous|prior|your) instructions|do not (tell|inform|mention (this )?to|reveal (this )?to) the user|without (telling|informing) the user|<\s*\/?\s*(important|system|instructions?|secret)\b/i;

/** Why a server's tools disqualify it, or `null`. */
export function toolMetadataConcern(
  tools: readonly { name: string; description: string }[],
): string | null {
  if (tools.length === 0) return 'lists no tools';
  if (tools.length > MAX_TOOLS) return 'lists more tools than any connector needs';
  for (const tool of tools) {
    const text = `${tool.name}\n${tool.description}`;
    if (hasInvisibleText(text)) return `tool ${tool.name.slice(0, 64)} hides characters`;
    if (tool.description.length > MAX_TOOL_DESCRIPTION) {
      return `tool ${tool.name.slice(0, 64)} has an oversized description`;
    }
    if (INSTRUCTION_TO_MODEL.test(text)) {
      return `tool ${tool.name.slice(0, 64)} carries instructions to the model`;
    }
  }
  return null;
}

/** The row's next health, from what the probe answered. */
export function healthAfter(row: McpCatalogueRow, answer: ProbeAnswer): CatalogueHealthRecord {
  if (answer.outcome === 'open') {
    const concern = toolMetadataConcern(answer.tools);
    if (concern) {
      return { health: 'failing', auth: 'none', healthMessage: concern, consecutiveFailures: 2 };
    }
    return {
      health: 'healthy',
      auth: 'none',
      healthMessage: null,
      consecutiveFailures: 0,
      toolCount: answer.tools.length,
    };
  }
  if (answer.outcome === 'oauth') {
    return {
      health: 'healthy',
      auth: answer.registration ? 'oauth' : 'needs_provider_app',
      healthMessage: answer.registration ? null : 'its OAuth server offers no client registration',
      consecutiveFailures: 0,
    };
  }
  const failures = row.consecutiveFailures + 1;
  return {
    // One failure keeps what it was (offered or not) until the retry within the hour decides.
    health: failures >= 2 ? 'failing' : row.health,
    healthMessage: answer.reason.slice(0, 300),
    consecutiveFailures: failures,
  };
}

export interface HealthRoundReport {
  checked: number;
  healthy: number;
  /** Checks that failed: a first failure (checked again within the hour) or a server now failing. */
  failed: number;
  /** Healthy, but its sign-in needs a client its provider issues: not offered. */
  needsProviderApp: number;
  /** Failed reasons, by first words, for the report. */
  reasons: Record<string, number>;
  /** Integrations could not be asked: the round stopped there. */
  interrupted: boolean;
}

function reasonKey(reason: string): string {
  return reason
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d+/g, 'N')
    .slice(0, 80);
}

/** Check the servers that are due, at most `limit` of them. */
export async function checkCatalogueHealth(
  db: ApiDatabase,
  {
    probe = probeThroughIntegrations,
    limit = 600,
    concurrency = CONCURRENCY,
    now = () => new Date(),
  }: { probe?: Probe; limit?: number; concurrency?: number; now?: () => Date } = {},
): Promise<HealthRoundReport> {
  const report: HealthRoundReport = {
    checked: 0,
    healthy: 0,
    failed: 0,
    needsProviderApp: 0,
    reasons: {},
    interrupted: false,
  };
  const due = await listCatalogueRowsDueForCheck(db, now(), limit);
  let next = 0;

  const worker = async () => {
    while (!report.interrupted && next < due.length) {
      const row = due[next];
      next += 1;
      const answer = await probe(row.url, row.transport);
      if (!answer) {
        report.interrupted = true;
        return;
      }
      const record = healthAfter(row, answer);
      await recordCatalogueHealth(db, row.id, record, now());
      if (
        answer.outcome === 'open' &&
        record.health === 'healthy' &&
        answer.server?.icons?.length
      ) {
        await storeServerLogo(db, row.id, answer.server.icons, now()).catch(() => undefined);
      }
      report.checked += 1;
      if (record.health === 'healthy' && record.auth === 'needs_provider_app') {
        report.needsProviderApp += 1;
      } else if (record.health === 'healthy') {
        report.healthy += 1;
      } else {
        report.failed += 1;
        const reason = reasonKey(record.healthMessage ?? 'unknown');
        report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (report.interrupted) {
    log.general.warn({ report }, 'Connector health round stopped: integrations could not be asked');
  }
  return report;
}
