# 36. An external agent has no Oxy account; its identity is its own row

Status: Accepted (2026-11-13, the owner's decision: an external agent must stay customisable but must
not get an Oxy account — adding Claude, Codex or OpenCode for a while is not creating an account).
Supersedes the "usual Oxy `bot` account" of [ADR 0030](./0030-external-agents.md) §3 and the
surviving bot account of [ADR 0032](./0032-external-agents-resume-sessions-and-leave-with-their-link.md) §2.
Date: 2026-11-13.

## Context

Pairing a CLI (`codea connect`, `POST /agents/external/redeem`) minted an Oxy `bot` account with a
username, a display name, a bio, a colour and a character, then an `agents` row naming it. Revoking
deleted the row and left the account. Production held two such accounts for one live external agent
(`claude-codebot`, from a revoked pairing, and `claude-code-zw6rbot`).

An external agent is a CLI on its owner's computer, connected for as long as the daemon runs. It acts
as nobody at Oxy: its turns are answered by the daemon (ADR 0030), with no tools, memory or tasks of
Gemies'. An account gave it nothing but a handle nobody chose, and left a row in Oxy's account graph
for every pairing.

Everything that reads who a gemie is went through the account: `lib/agent-identity.ts` resolved the
name, handle and colour from Oxy, `lib/agent-account.ts` asked Oxy who may use or change it, the app
addressed it as `/@handle` and the editor wrote its name and colour to the account.

## Decision

1. **A gemie's identity has a source** (`agents.identity`, `domain/agent.ts`): `oxy`, the account
   `oxy_account_id` names (every gemie so far), or `local`, a name (`local_name`) and a colour
   (`local_color`, in the vocabulary of an account's `User.color`) kept on its row, beside the
   character every gemie already keeps there. Two CHECKs hold the columns to the source
   (`agents_identity_check`) and keep a `local` gemie its owner's alone (`agents_local_identity_check`:
   unlisted, private, no mailbox, nobody's own assistant, an owner). In code the row is one
   union, `StoredAgentIdentity`, so a reader says which source it handles instead of testing nulls.
2. **Pairing creates a `local` gemie and no account.** Its name is `<CLI> · <computer>`, its colour
   the CLI's (`EXTERNAL_AGENT_CLI_COLORS`), its character picked from its name; its owner is the
   person who paired it.
3. **Identity is resolved in one place for both sources** (`attachAgentIdentities`): an `oxy` gemie
   from Oxy in one batch, a `local` one from its row with no handle. Every surface — the sidebar, a
   thread, a room, a consultation, the catalogue card, the task listings, the SDK profile — reads it
   from there.
4. **Who may use or change a `local` gemie is its owner, and Oxy is not asked**
   (`lib/agent-account.ts`, `ownsLocalGemie`): the write gate (`loadAgentForActor`) and the reach
   gate (`canReachAgent`) answer it from `owner_oxy_account_id`; anybody else gets the same not-found
   an Oxy gemie gives a stranger. It opens wherever its owner does (no application confines it).
5. **Its address is its id.** The API already answers a thread by id (`GET /agents/:id/thread`); the
   app opens it at `/agents/<id>` and edits it at `/agents/edit/<id>`. It has no page
   (`/@handle/details`) and nothing to share or publish: `PATCH /agents/:id` refuses `isPublished`
   and `access: 'public'` for it.
6. **Nothing that needs an account of its own is open to it**, refused where it would start:
   unattended work and automations (`unattendedReach`), background sessions (`startAgentSession`,
   `no_background_work`), the heartbeat (`establishAgentWork`), event subscriptions, connected
   accounts (`loadGrantableGemie`), feature gates, and an Oxy task for a room member.
   `lib/gemie-oxy-actor.ts` is the seam: `gemieOxyAccountId` is what a gate asks, and
   `runtimeGemieAccountId` — Gemies' own runtime, which a `local` gemie never enters — throws
   rather than act as nobody.
7. **Its owner customises it with the same editor**: the name and the colour are written to its
   row through `PATCH /agents/:id` (`name`, `color`; an `oxy` gemie's colour stays its account's and
   is a 400 there), the character as for any gemie. The editor shows no handle and none of the
   cards of Gemies' runtime (work, accounts, events, inbox, memory).
8. **The existing ones were migrated** with the rolling-deploy pattern: 0148 (pre) adds the columns
   and the CHECKs `NOT VALID`; 0149 (post) turns every live external agent `local` with the name and
   colour pairing gave its account, which were still unedited in production; 0150 (post) validates.

## Consequences

- A paired agent leaves nothing behind at Oxy, and revoking it deletes all of it.
- Codea needs no change: the daemon reads only `agentId` and `name` from `redeem`, which no longer
  answers a `handle`.
- The bot accounts minted before this are not deleted by Gemies: it holds no authority over an
  account it did not keep, and archiving one is its owner's act (`DELETE /accounts/:id`,
  `account:delete`, which the parent account's owner holds).
- A `local` gemie cannot be consulted by another person's gemie or join another person's room: it
  is reachable by its owner alone, which is what an agent on somebody's own computer should be.

## Enforcement

- `agents_identity_check` and `agents_local_identity_check` in the database
  (`db/__tests__/externalAgentsAreLocalMigration.pgdb.test.ts`).
- `StoredAgentIdentity` makes every reader of the account handle both sources at compile time.
- `lib/__tests__/local-gemie-identity.test.ts` (resolution, authority, edits, closed lanes),
  `routes/agents/__tests__/external-agents.test.ts` (pairing mints no account), and the app's
  `agent-address.test.ts` and `autosave-writes-once.test.tsx` (address by id, editor writes the row).
