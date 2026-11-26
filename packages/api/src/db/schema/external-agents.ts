/**
 * External agents (ADR 0030): agents whose turns run on a person's own machine, in a coding-agent CLI
 * they are already logged in to, reached through a daemon (`gemies connect`) that dials Alia.
 *
 * Two small tables and nothing on `agents`: an external agent is an ordinary agent row plus a link
 * row, so the hot `agents` table gains no column, no CHECK and no migration lock.
 */
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';
import { checkOneOf } from './columns';
import { EXTERNAL_AGENT_CLIS, EXTERNAL_TOOL_CALL_OUTCOMES } from '../../domain/external-agent';

/**
 * A single-use pairing code, minted in the app by a signed-in person and redeemed by the daemon with
 * no session at all (ADR 0038): the code is the authorisation, bound to `owner_oxy_user_id`.
 *
 * Only the SHA-256 of the code is stored: the code is a credential until it is redeemed, so a
 * database read must not yield one. `expires_at` is the sweep clock (`db/expiryTargets.ts`); a
 * redeemed row is kept until then so a replay answers "already used" rather than "unknown".
 *
 * `agent_id` names an existing external agent when the code reconnects it (a new machine, a lost
 * credential, the migration off the Oxy session): redeeming replaces that agent's credential rather
 * than creating a gemie. Null for a new connection.
 */
export const externalAgentPairings = pgTable(
  'external_agent_pairings',
  {
    id: text().primaryKey(),
    codeHash: text().notNull(),
    ownerOxyUserId: text().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz().notNull(),
    redeemedAt: timestamptz(),
    agentId: text(),
  },
  (t) => [
    uniqueIndex('external_agent_pairings_code_hash_key').on(t.codeHash),
    index('external_agent_pairings_expiry_idx').on(t.expiresAt),
    index('external_agent_pairings_owner_idx').on(t.ownerOxyUserId),
  ],
);

/**
 * The link between an agent and the machine that serves it.
 *
 * `agent_id` is the `agents._id` of the ordinary agent row; it is the key, so one agent has at most
 * one link. No foreign key: agent rows are created and deleted by flows that must not be blocked by
 * a daemon (`CONVENTIONS.md`, "foreign keys are declared per reference"), and a link whose agent is
 * gone is inert — `findExternalLink` is only reached from an agent that exists.
 *
 * `credential_hash` is the SHA-256 of the credential the daemon presents (ADR 0038). Null only on a
 * link paired before credentials existed, which the relay still lets the owner's Oxy session open
 * until it is reconnected; every link paired since has one.
 *
 * `machine_id` groups the links one pairing made (ADR 0043): a computer paired once serves a gemie
 * per CLI it has, and those share it. Null on a link paired one CLI at a time, before machines.
 */
export const externalAgentLinks = pgTable(
  'external_agent_links',
  {
    agentId: text().primaryKey(),
    ownerOxyUserId: text().notNull(),
    cli: text({ enum: EXTERNAL_AGENT_CLIS as unknown as [string, ...string[]] }).notNull(),
    hostName: text().notNull(),
    credentialHash: text(),
    machineId: text(),
    createdAt: createdAt(),
    lastConnectedAt: timestamptz(),
    revokedAt: timestamptz(),
  },
  (t) => [
    index('external_agent_links_owner_idx').on(t.ownerOxyUserId),
    index('external_agent_links_machine_idx').on(t.machineId),
    checkOneOf('external_agent_links_cli_check', t.cli, EXTERNAL_AGENT_CLIS),
  ],
);

/**
 * One call an external agent made to its tools over MCP (ADR 0039): which tool, the risk the
 * governance gave it, what came of it and how long it took. The audit trail of a lane no chat turn
 * records; its arguments and results are not kept, since they may hold the person's data.
 * Swept after 90 days (`db/expiryTargets.ts`).
 */
export const externalAgentToolCalls = pgTable(
  'external_agent_tool_calls',
  {
    id: text().primaryKey(),
    agentId: text().notNull(),
    ownerOxyUserId: text().notNull(),
    toolName: text().notNull(),
    riskLevel: text({ enum: ['R0', 'R1', 'R2', 'R3'] }).notNull(),
    outcome: text({
      enum: EXTERNAL_TOOL_CALL_OUTCOMES as unknown as [string, ...string[]],
    }).notNull(),
    durationMs: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('external_agent_tool_calls_agent_idx').on(t.agentId, t.createdAt),
    index('external_agent_tool_calls_created_idx').on(t.createdAt),
    checkOneOf('external_agent_tool_calls_risk_check', t.riskLevel, ['R0', 'R1', 'R2', 'R3']),
    checkOneOf('external_agent_tool_calls_outcome_check', t.outcome, EXTERNAL_TOOL_CALL_OUTCOMES),
  ],
);

/**
 * A session a person opened with an external agent from the app (ADR 0043): the conversation, and
 * the folder on the agent's computer it works in. The daemon accepts the folder only inside the
 * roots its owner allowed there, so a row here asks; it never grants.
 *
 * Keyed by the conversation, which the app names before the first message. No foreign keys: the
 * conversation and the agent are created and deleted by flows this must not block.
 */
export const externalAgentSessions = pgTable(
  'external_agent_sessions',
  {
    conversationId: text().primaryKey(),
    agentId: text().notNull(),
    ownerOxyUserId: text().notNull(),
    cwd: text().notNull(),
    /** The CLI's own id of a session begun in a terminal that this conversation continues (§4). */
    cliSessionId: text(),
    createdAt: createdAt(),
  },
  (t) => [index('external_agent_sessions_agent_idx').on(t.agentId, t.createdAt)],
);
