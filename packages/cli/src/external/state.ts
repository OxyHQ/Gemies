import { chmodSync } from 'node:fs';
import Conf from 'conf';
import { DEFAULT_API_BASE_URL, RETIRED_API_BASE_URL } from '../utils/config.js';
import type { ExternalCli } from './types.js';

export interface PairedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly cli: ExternalCli;
  /** Where this machine pairs from; a different Gemies is a different agent. */
  readonly apiBaseUrl: string;
  /**
   * The agent's own credential (Gemies ADR 0038), returned once by redeeming its code. It opens this
   * agent's connection and nothing else. Absent on an agent paired by Codea 3.x, which connected with
   * the person's Oxy session and must be reconnected from Gemies once.
   */
  readonly credential?: string;
  /** The folder its CLI works in, chosen when it was paired (`--cwd`, or where `connect` ran). */
  readonly cwd?: string;
  /** Whether its CLI may edit files there (`--read-only` turns it off). */
  readonly write?: boolean;
}

interface Schema {
  agents: PairedAgent[];
  /** `<agentId>:<conversation>` -> the CLI's own session id, so a conversation continues it. */
  sessions: Record<string, string>;
}

const MAX_SESSIONS = 300;

export interface SessionStore {
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  delete(key: string): void;
}

/**
 * Which agents this machine serves, with their credentials: readable by its owner only (0600), so
 * nobody else on the machine can connect as one of their agents.
 */
const store = new Conf<Schema>({
  projectName: 'alia-codea-cli',
  configName: 'external-agents',
  defaults: { agents: [], sessions: {} },
  configFileMode: 0o600,
});

// Agents paired against the backend's previous host are the same agents on the
// same backend: they move with `apiBaseUrl` instead of asking to pair again.
const agents = store.get('agents');
if (agents.some((agent) => agent.apiBaseUrl === RETIRED_API_BASE_URL)) {
  store.set(
    'agents',
    agents.map((agent) =>
      agent.apiBaseUrl === RETIRED_API_BASE_URL
        ? { ...agent, apiBaseUrl: DEFAULT_API_BASE_URL }
        : agent,
    ),
  );
}

export function pairedAgents(apiBaseUrl: string): PairedAgent[] {
  return store.get('agents').filter((agent) => agent.apiBaseUrl === apiBaseUrl);
}

export function rememberAgent(agent: PairedAgent): void {
  const others = store.get('agents').filter((a) => a.agentId !== agent.agentId);
  store.set('agents', [...others, agent]);
  // Asserted, not assumed: a file written by an older version, or by a write path that ignores the
  // mode, would otherwise keep a credential world-readable.
  chmodSync(store.path, 0o600);
}

/**
 * Forgets an agent this machine serves with `credential`. Another daemon on this machine may have
 * reconnected the same agent meanwhile; that entry holds a newer credential and is kept.
 */
export function forgetAgent(agentId: string, credential: string): void {
  store.set(
    'agents',
    store.get('agents').filter((a) => a.agentId !== agentId || a.credential !== credential),
  );
}

/** Forgets every agent this machine serves (`codea disconnect --forget`). */
export function forgetAllAgents(): void {
  store.set('agents', []);
}

/** Persisted, so a conversation survives a restart of the daemon. Bounded: the oldest are dropped. */
export function sessionStore(): SessionStore {
  return {
    get: (key) => store.get('sessions')[key],
    set(key, sessionId) {
      const sessions = store.get('sessions');
      // The same id again (every turn of a resumed session reports it) needs no write.
      if (sessions[key] === sessionId) return;
      const { [key]: _replaced, ...rest } = sessions;
      store.set(
        'sessions',
        Object.fromEntries(Object.entries({ ...rest, [key]: sessionId }).slice(-MAX_SESSIONS)),
      );
    },
    delete(key) {
      const { [key]: _gone, ...rest } = store.get('sessions');
      store.set('sessions', rest);
    },
  };
}
