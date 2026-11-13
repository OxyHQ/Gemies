/**
 * The agent shapes the API serves and accepts.
 *
 * These lived in `lib/stores/agents-store.ts` while that store WAS the agent
 * data layer. It is gone — every agent read and write is a TanStack query or
 * mutation now — so the types moved here rather than being copied to each hook
 * that needs them. `src/features/agents/runtime/use-agents.ts` and `src/features/agents/runtime/use-my-agents.ts`
 * are the two places that fetch them.
 */

export type AgentArchetype = 'general' | 'qa' | 'task_router' | 'status_update';

export interface RoutingRule {
  condition: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignTo: { type: 'agent' | 'team' | 'user'; id: string; name?: string };
}

export interface ArchetypeConfig {
  // Q&A
  citeSources?: boolean;
  // Task Router
  inboundChannels?: string[];
  routingRules?: RoutingRule[];
  defaultAssignee?: { type: 'agent' | 'team' | 'user'; id: string; name?: string };
  escalationTimeoutMinutes?: number;
  // Status Update
  reportTemplate?: string;
  reportFormat?: 'markdown' | 'html' | 'plain';
  deliveryChannels?: string[];
  schedule?: {
    type: 'daily' | 'interval' | 'cron';
    time?: string;
    days?: string[];
    intervalMinutes?: number;
    cron?: string;
  };
  compareWithPrevious?: boolean;
}

/**
 * Where a gemie's identity lives (Gemies ADR 0036): the Oxy `bot` account it IS, or its own row —
 * a gemie with no Oxy account, which an external agent (a CLI paired from its owner's computer)
 * is. A `local` gemie has no handle, is addressed by its id, and is its owner's alone: it is never
 * listed or shared, and has no connected accounts, inbox or background work.
 */
export type AgentIdentitySource =
  | { source: 'oxy'; oxyAccountId: string }
  | { source: 'local'; name: string; color: string };

/**
 * An agent, as the API serves it.
 *
 * An `oxy` gemie IS an Oxy `bot` account (`identity.oxyAccountId`), and `name`,
 * `handle` and `color` are READ from that account rather than stored by Gemies.
 * They are nullable because the API resolves them through a batched Oxy lookup
 * that FAILS OPEN — an account it cannot resolve leaves the three null and the
 * listing still renders, because the tagline, the rating and the price are
 * Gemies' own. A `local` gemie's name and colour are its row's, and it has no
 * handle.
 *
 * The editor writes them where they live: an `oxy` gemie's at Oxy
 * (`accounts.update`), a `local` gemie's through `PATCH /agents/:id`.
 *
 * What an agent LOOKS like is its `character` (a Bloom avatar character chosen in the agent editor:
 * its shape and features) painted in its `color`, the account's: the character carries no colour
 * of its own, and `readAgentCharacter(character, color)` is how every surface draws it. The editor
 * writes the colour to the account, as it writes the name.
 */
export interface Agent {
  _id: string;
  /** Where its name and colour live: its Oxy account, or its own row. */
  identity: AgentIdentitySource;
  /**
   * What the agent looks like apart from its colour, as the server stores it: JSON, parsed and
   * painted in `color` where it is drawn (`readAgentCharacter`). Never absent: every agent has one.
   */
  character: unknown;
  /** Its owner: the bot's parent in Oxy's account graph, or who made a `local` gemie. */
  ownerOxyAccountId: string | null;
  name: string | null;
  handle: string | null;
  color: string | null;
  tagline: string;
  description: string;
  /** The Oxy account that created the agent. An id, never a name. */
  author: string;
  /** The author's display name, resolved by the API from Oxy. */
  authorName: string | null;
  /**
   * What the caller may do with it, on the card `GET /agents/:id` answers (ADR 0035): change it
   * (`mayEdit`), and grant it their own connected accounts (`mayGrantAccounts`, every person on
   * Alia). Absent on lists and on a write's answer, which only an editor gets.
   */
  viewer?: { mayEdit: boolean; mayGrantAccounts: boolean };
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  hireCount: number;
  maxConcurrentThreads: number;
  price: number | null;
  /**
   * What this agent may reach: `family` or `family:instanceId` strings.
   *
   * EMPTY DENIES EVERYTHING, which is the reverse of the three vocabularies it
   * replaced — `capabilities`, `permissions` and
   * `archetypeConfig.knowledgeSources`, where an unset value meant *allowed*.
   * The labels live in `src/features/chat/model/capability-families.ts`; the vocabulary
   * itself is the API's.
   */
  capabilityGrants: string[];
  skills: Array<{
    _id: string;
    name: string;
    displayName: string;
    icon: string | null;
    color: string | null;
  }>;
  /**
   * The newest line of THIS person's thread with the agent, and when it landed.
   *
   * Served by `GET /agents/me` only, and `null` on an agent nobody has spoken to
   * yet — which is the ordinary case the moment one is created. Absent entirely
   * on the catalogue's agents, which is a different list about other people's
   * agents and has no thread to speak of.
   */
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  /** Messages in the thread the person has not seen: the row's badge. */
  unreadCount?: number;
  /**
   * Set when the agent is a coding-agent CLI on the person's own computer (ADR 0030): which CLI,
   * and whether its computer is connected to Alia right now. `null` for every other agent.
   */
  external?: { cli: 'claude' | 'codex' | 'opencode'; online: boolean } | null;
  /**
   * The space (ADR 0028) this agent is in, or `null`. Served by `GET /agents/me`; an agent in a
   * space is listed under it and not in the flat Agents list. Absent on an older answer reads as none.
   */
  spaceId?: string | null;
  knowledge: Array<{ _id: string; name: string; type: string; category: string; url: string }>;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: 'active' | 'idle' | 'offline';
  /**
   * Who may USE this agent, as opposed to who may FIND it — `isPublished`
   * answers the second. `private` is its owner plus whoever holds a membership
   * on its bot account, which is how an agent is shared; `public` is anyone.
   */
  access: 'private' | 'public';
  systemPrompt?: string;
  /**
   * The model this agent answers with (`publisher/model`), or `null` for the
   * server's default. Optional because a server older than real models does
   * not send it.
   */
  modelId?: string | null;
  /** Minutes between heartbeats (ADR 0026); `null` or absent means the agent has none. */
  scheduleInterval?: number | null;
  /**
   * Whose computer it works on when it has one: `alia`, the person's shared workspace (the default and
   * only for its owner), or its `own` machine. Absent on an older answer reads as `alia`.
   */
  computerSource?: 'alia' | 'own';
  archetype?: AgentArchetype;
  archetypeConfig?: ArchetypeConfig;
  /** What its empty chat offers to send, at most {@link MAX_AGENT_STARTERS} (ADR 0020 §6). */
  starters?: AgentStarter[];
  /** Which of Alia's features an app's entitlement unlocks (ADR 0020 §6). */
  featureGates?: AgentFeatureGates;
  /** The app tools active from the first step of its turns, as `<appId>:<tool>` keys. */
  primaryTools?: string[];
  createdAt: string;
  updatedAt: string;
}

/** A conversation starter, as `PATCH /agents/:id` takes it (`title` ≤ 60, `prompt` ≤ 500). */
export interface AgentStarter {
  title: string;
  prompt: string;
}

export const MAX_AGENT_STARTERS = 6;
export const MAX_STARTER_TITLE_LENGTH = 60;
export const MAX_STARTER_PROMPT_LENGTH = 500;

/** The Alia features an owner may put behind an app's entitlement, as the API names them. */
export const GATED_FEATURES = [
  'attachments.documents',
  'attachments.images',
  'deep_research',
  'power_level.pro',
  'power_level.ultra',
] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

/** One gate: a feature declared in an app's capability catalogue. */
export interface AgentFeatureGate {
  app: string;
  feature: string;
}

export type AgentFeatureGates = Partial<Record<GatedFeature, AgentFeatureGate>>;

/**
 * Write payload for agent updates. Unlike the read {@link Agent} model, `skills`
 * and `knowledge` are sent as bare id arrays — the API resolves them to full
 * objects on the way back.
 *
 * `name` and `color` are who the gemie is, and only a gemie with no Oxy account
 * keeps them on its row: an `oxy` gemie's are its account's, written at Oxy by
 * the editor (`PATCH /agents/:id` answers 400 for its colour). The handle, the
 * account and the owner are OMITTED, not optional: the strict schema answers
 * 400 for them.
 */
export type AgentUpdate = Partial<
  Omit<
    Agent,
    | 'skills'
    | 'knowledge'
    | 'name'
    | 'handle'
    | 'color'
    | 'avatar'
    | 'identity'
    | 'ownerOxyAccountId'
    | '_id'
  >
> & {
  skills?: string[];
  knowledge?: string[];
  name?: string;
  color?: string;
};

/**
 * What `POST /agents` accepts: the runtime, plus the account the agent IS.
 *
 * `oxyAccountId` is REQUIRED and the caller mints it first — `useOxy()
 * .createAccount({ kind: 'bot', … })` — because Oxy owns the account and only
 * the person's own credential may create one under their tree.
 */
export type AgentCreate = { oxyAccountId: string } & Pick<
  Agent,
  'tagline' | 'description' | 'category'
> &
  Partial<
    Pick<
      Agent,
      | 'tags'
      | 'price'
      | 'capabilityGrants'
      | 'isPublished'
      | 'access'
      | 'systemPrompt'
      | 'modelId'
      | 'archetype'
      | 'archetypeConfig'
    >
  > & { skills?: string[]; knowledge?: string[] };
