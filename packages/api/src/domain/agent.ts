/**
 * Closed value sets for `agent`.
 *
 * These live in `domain/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and this module must stay a leaf that imports nothing.
 */

export const AGENT_ARCHETYPES = ['general', 'qa', 'task_router', 'status_update'] as const;
export type AgentArchetype = (typeof AGENT_ARCHETYPES)[number];
/**
 * Exported as a TUPLE for the same reason `AGENT_ARCHETYPES` already is: the
 * Postgres schema renders its CHECK from this exact value rather than retyping
 * it, so the constraint and this validator cannot drift apart.
 */
export const AGENT_STATUSES = ['active', 'idle', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Whose computer an agent works on when it has the `computer` capability.
 *
 *  - `alia` (the default): the person's own shared workspace, the same machine Alia's `alia:user:<id>`
 *    actor names — what the agents of one person share, so a file one made is there for the next.
 *  - `own`: a machine of the agent's own, per person (`agent:<id>:user:<id>`).
 *
 * `alia` only ever applies for the agent's OWNER (`resolveComputerActor`): a stranger using a public
 * agent never has it work on their personal workspace, whatever the owner chose.
 */
export const AGENT_COMPUTER_SOURCES = ['alia', 'own'] as const;
export type AgentComputerSource = (typeof AGENT_COMPUTER_SOURCES)[number];

/**
 * Who may USE an agent — a different question from whether it is listed.
 *
 * `is_published` answers "does it appear in the catalogue", and until now it
 * answered both: anything published could be used by anyone, so "let people
 * find it" and "let people run it" were one switch and the useful combination
 * — listed, but mine to lend — could not be expressed.
 *
 *  - `private` — its owner, and whoever holds a membership on its bot account.
 *    Sharing IS adding a member, which is what "hiring" became.
 *  - `public` — anyone.
 *
 * The default is `private`, matching the account the agent is born with, which
 * is created opted out of discovery.
 */
export const AGENT_ACCESS = ['private', 'public'] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];

/**
 * Where a gemie remembers the person it works for (ADR 0034 §2). Never both, and never another
 * gemie's: memory is per actor.
 *
 *  - `nilo`: in the person's Nilo `memories` database, through the `nilo-memories` catalogue
 *    (`oxy_nilo_memories__*`), with the answer settings and learned writing style in
 *    `user_memories`. Alia's.
 *  - `gemie` (the default): in its own `agent_memory_documents`, per gemie and person (the
 *    `memory` tool and `searchThread`, under the `memory` grant).
 */
export const AGENT_MEMORY_STORES = ['nilo', 'gemie'] as const;
export type AgentMemoryStore = (typeof AGENT_MEMORY_STORES)[number];

/**
 * What a gemie reaches for the person present (ADR 0034 §2).
 *
 *  - `person`: it is the person's own assistant. Every connector, integration and agent the person
 *    has (the instanced families answer "every row"), the skills the person installed, the person's
 *    name and Inbox context, on Oxy's person lane (`lib/gemie-oxy-actor.ts`) and under the base
 *    identity, with no remit of its own. Its fixed families are still its `capability_grants`.
 *    Alia's.
 *  - `grants` (the default): exactly what its `capability_grants` name, the skills linked to it,
 *    under its own remit and name.
 */
export const AGENT_REACHES = ['person', 'grants'] as const;
export type AgentReach = (typeof AGENT_REACHES)[number];

/**
 * How a gemie's work outside a chat turn is authorized and run (ADR 0034 §2).
 *
 *  - `standing`: under the person's standing Oxy authority, asked for when a task is saved with
 *    the person present (`alia_task_authorizations`), on the `alia-tasks` queue. No agent
 *    session: its chat turns are not durable thread turns either. Its chats are loose, and its
 *    thread with a person is one `agent_threads` row (`lib/gemie-thread.ts`). Alia's.
 *  - `session` (the default): durable agent sessions (ADR 0011, ADR 0033), and every chat turn is
 *    a turn of its thread: every conversation with the person.
 */
export const AGENT_TASK_AUTHORITIES = ['standing', 'session'] as const;
export type AgentTaskAuthority = (typeof AGENT_TASK_AUTHORITIES)[number];

/**
 * `archetype_config`, and the ONE place its stored shape is narrowed.
 *
 * The column is `jsonb` and nothing validates it on the way in: it holds a union
 * of four archetypes' settings, selected by `archetype`, and no writer checks
 * that the two agree. So the repository types it `unknown` — which is honest —
 * and every reader narrows through {@link readArchetypeConfig} rather than
 * asserting a shape onto it.
 *
 * The narrowing lives here, beside the archetype vocabulary that selects it, and
 * NOT in the schema as a `$type<…>()`: a `$type` would tell `tsc` the stored
 * value has this shape, which is exactly the claim nothing enforces.
 */
interface ArchetypeAssignee {
  type?: string;
  id?: string;
  name?: string;
}

interface ArchetypeRoutingRule {
  condition?: string;
  priority?: string;
  assignTo?: ArchetypeAssignee;
}

interface ArchetypeSchedule {
  type?: string;
  time?: string;
  days?: string[];
  intervalMinutes?: number;
  cron?: string;
}

/**
 * `knowledgeSources` and `dataSources` were here, and they are GONE.
 *
 * Two identically shaped lists of integration, MCP-server and Oxy-service names
 * — the third of the three vocabularies that answered "what may this agent
 * touch", and the only one that never even claimed to reach the tool set: its
 * single reader spliced the names into a prompt as prose. `capability_grants`
 * replaces all three; `domain/capability-grants.ts` has the argument.
 */
export interface ArchetypeConfig {
  // Q&A
  citeSources?: boolean;
  // Task router
  inboundChannels?: string[];
  routingRules?: ArchetypeRoutingRule[];
  defaultAssignee?: ArchetypeAssignee;
  escalationTimeoutMinutes?: number;
  // Status update
  reportTemplate?: string;
  reportFormat?: string;
  deliveryChannels?: string[];
  schedule?: ArchetypeSchedule;
  compareWithPrevious?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function readAssignee(value: unknown): ArchetypeAssignee | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  return {
    ...(typeof record.type === 'string' && { type: record.type }),
    ...(typeof record.id === 'string' && { id: record.id }),
    ...(typeof record.name === 'string' && { name: record.name }),
  };
}

function readSchedule(value: unknown): ArchetypeSchedule | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  return {
    ...(typeof record.type === 'string' && { type: record.type }),
    ...(typeof record.time === 'string' && { time: record.time }),
    ...(stringArray(record.days) !== undefined && { days: stringArray(record.days) }),
    ...(typeof record.intervalMinutes === 'number' && {
      intervalMinutes: record.intervalMinutes,
    }),
    ...(typeof record.cron === 'string' && { cron: record.cron }),
  };
}

/**
 * The stored value, reduced to the members that are the type they claim to be.
 *
 * Returns an EMPTY config rather than null for a value that is not an object,
 * because every caller's next move is to read optional members off it — the
 * source spelled that `agent.archetypeConfig || {}`, and the two answers are the
 * same for a reader and different only for somebody testing presence.
 */
export function readArchetypeConfig(value: unknown): ArchetypeConfig {
  const record = asRecord(value);
  if (record === null) return {};
  return {
    ...(typeof record.citeSources === 'boolean' && { citeSources: record.citeSources }),
    ...(stringArray(record.inboundChannels) !== undefined && {
      inboundChannels: stringArray(record.inboundChannels),
    }),
    ...(Array.isArray(record.routingRules) && {
      routingRules: record.routingRules.flatMap((rule): ArchetypeRoutingRule[] => {
        const ruleRecord = asRecord(rule);
        if (ruleRecord === null) return [];
        return [
          {
            ...(typeof ruleRecord.condition === 'string' && { condition: ruleRecord.condition }),
            ...(typeof ruleRecord.priority === 'string' && { priority: ruleRecord.priority }),
            ...(readAssignee(ruleRecord.assignTo) !== undefined && {
              assignTo: readAssignee(ruleRecord.assignTo),
            }),
          },
        ];
      }),
    }),
    ...(readAssignee(record.defaultAssignee) !== undefined && {
      defaultAssignee: readAssignee(record.defaultAssignee),
    }),
    ...(typeof record.escalationTimeoutMinutes === 'number' && {
      escalationTimeoutMinutes: record.escalationTimeoutMinutes,
    }),
    ...(typeof record.reportTemplate === 'string' && { reportTemplate: record.reportTemplate }),
    ...(typeof record.reportFormat === 'string' && { reportFormat: record.reportFormat }),
    ...(stringArray(record.deliveryChannels) !== undefined && {
      deliveryChannels: stringArray(record.deliveryChannels),
    }),
    ...(readSchedule(record.schedule) !== undefined && {
      schedule: readSchedule(record.schedule),
    }),
    ...(typeof record.compareWithPrevious === 'boolean' && {
      compareWithPrevious: record.compareWithPrevious,
    }),
  };
}
