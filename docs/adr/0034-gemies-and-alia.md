# 34. Gemies and Alia: agents become Gemies, and Alia is one of them

*Gemies y Alia: los agentes pasan a ser Gemies, y Alia es uno de ellos.*

**Status:** Accepted (implementation in progress, phased below)

**Date:** 2026-11-12

**Amends:** ADR 0015 §1 (Alia is no longer a separate kind of actor) and ADR 0020 §1 ("Alia herself
is the default lead of every conversation, not a special agent type").

## Context

**This ADR comes from the owner's decision of 2026-11-12.** Until now one repository (`OxyHQ/Alia`)
was both Oxy's assistant and a platform for people's agents, with one backend. In code Alia was
"the turn without an `agentId`": a `null` in `conversations.agent_id`, `messages.agent_info*`,
`voice_calls.agent_id` and `bots.agent_id`, the actor `{ type: 'alia' }` in
`lib/oxy-task-authority.ts`, `actorSelection { mode: 'alia' }` in automations, and branches on
`!agent` in `lib/tool-pipeline.ts`, `lib/chat/turn-inputs.ts` and `lib/system-prompt-builder.ts`.

The owner separates the two products: Alia stays the assistant everybody knows, with a single
agent, and the agent platform becomes its own product with its own brand.

## Decision

### 1. Gemies is the agent platform

- Everything that is an agent today is a **gemie** ("Create your Gemies. Let them work together.").
- This repository becomes **`OxyHQ/Gemies`** (domain `gemies.ai`). It was created from Alia with
  its whole history, as an independent repository rather than a GitHub fork.
- It owns:
  - the backend (same database and the same service, renamed; API at `api.gemies.ai`);
  - the SDK `@gemies/sdk` and the server client `@gemies/server` (npm scope `@gemies`);
  - the multi-gemie app.
- **The Gemies app has no conversation without a gemie.** Every chat belongs to a gemie, and Alia
  is listed among them.

### 2. Alia is one official, global gemie

- Alia is an `agents` row on the Oxy account `alia`, owned by Oxy's organization. It is public and
  published, and everybody uses the same one.
- What makes her different today becomes configuration of that gemie, not a `null`:
  - her memory lives in Nilo;
  - she has no mailbox and no computer;
  - her tasks run with standing authority.
- Every `agentId == null` branch and the `{ type: 'alia' }` actor are replaced by those attributes.
- The guarantees that hold today keep holding:
  - Alia's memory never reaches another gemie;
  - consulting a gemie stays one level deep.
- **Codea** is another official gemie (an expert programmer). Its CLI and VS Code extension live in
  their own repository, `OxyHQ/Codea`, and talk to that gemie.

### 3. Alia is a single-gemie app

- `OxyHQ/Alia` keeps the store listing (`onl.alia.app`), the scheme `alia`, the web at `alia.onl`
  and its users.
- Its app talks only to the Alia gemie, through `@gemies/sdk`: messages, voice, conversations,
  tasks, and consulting other gemies.
- It does not create, edit or group gemies; that is the Gemies app.

### 4. The default gemie

- An app that embeds the SDK opens the person's default gemie.
- The default is resolved on the server, in this order:
  1. the person's choice for that app;
  2. the app's own default (Homiio declares Sindi);
  3. the person's global choice;
  4. Alia.

### 5. Gemies bills

- Gemies is the single billable product. The person present pays, as ADR 0020 §4 already says.
- The Alia app shows the same balance and plan.

### 6. A clean cut

- `@alia.onl/sdk` and `@alia.onl/server` are replaced by `@gemies/*` with no bridge package.
- The SDK's components are renamed to `Gemie*`.
- Public routes and stream events take the Gemies vocabulary.
- `api.alia.onl` keeps answering only until its consumers have moved, then it is removed.

## Phases

1. Create `OxyHQ/Gemies` (done 2026-11-12). Its deploy workflows stay disabled until the
   infrastructure cut-over, so that two repositories never deploy the same service.
2. Contract with Oxy:
   - register the Gemies application;
   - turn Alia's coordinator lane into the Alia gemie's account;
   - make Gemies the billable product;
   - add the new origins.
3. Backend:
   - seed the Alia and Codea gemies;
   - replace `null` with configuration;
   - migrate the rows (pre/post), then make `conversations.agent_id NOT NULL`;
   - add the default-gemie setting;
   - adopt the Gemies vocabulary.
4. Infrastructure: ECS, SSM, ECR and Terraform renamed; `api.gemies.ai`; deploys move here and
   leave `OxyHQ/Alia` in the same change.
5. `@gemies/sdk` 1.0 and `@gemies/server` 1.0, then one PR per consuming repository.
6. The Gemies app (new bundle, `gemies.ai`).
7. `OxyHQ/Alia` reduced to its single-gemie app.
8. `api.alia.onl` removed.

Until phase 4, `OxyHQ/Alia` still deploys production. Changes merged there are merged into this
repository from Alia's `main`.

## Consequences

- Old native builds and apps still on `@alia.onl/sdk` stop chatting once routes and events change,
  until they update. This is the same trade-off the owner accepted in ADR 0020.
- Ordering the Alia OTA update and the consumer PRs before the cut keeps that window short.
- Database tables keep their names (`agents`, `agent_*`) until a later dedicated migration, so that
  the rename does not share a rolling-deploy window with the data migration.

## Alternatives considered

- **Keep Alia as a special actor (`agentId == null`) inside Gemies.** This was rejected because it
  keeps two code paths for one concept, and the owner asked for Alia to be bound to her gemie.
- **One Alia gemie per person.** This was rejected because Alia is the same assistant for
  everybody; a personal copy would fork her prompt, memory and mailbox per person.
- **A fresh database for Gemies.** This was rejected because people's agents and conversations
  would be lost.
- **A GitHub fork.** This was rejected by the owner, who wants the two repositories unlinked.

## Implementation record

### Phase 3, step 1: Alia is an `agents` row (2026-11-12)

- **Attributes, not a `null`.** Four columns every gemie has (`domain/agent.ts`), with an
  ordinary gemie's value as the default and Alia's row holding the other one:
  - `memory_store` (`nilo` | `gemie`);
  - `reach` (`person` | `grants`): the person's own assistant — Oxy's person lane, every row of
    the instanced families, the person's installed skills, name and Inbox context, the base
    identity with no remit — or a persona under its grants, linked skills and remit;
  - `mailbox` (boolean): `self_*` tools and own-mailbox alerts;
  - `task_authority` (`standing` | `session`): tasks on `alia-tasks` under standing authority,
    no agent session or thread; or durable sessions and thread turns.

  "No computer" is configuration too: her row holds no `computer` (nor `browser`) grant. Every
  `agentId == null` branch in the turn (`tool-pipeline`, `turn-inputs`, `system-prompt-builder`,
  `agent-turn`, the chat route, voice, channels, automations, email alerts) reads these attributes
  instead.
- **The row** is seeded by migration 0135 (pre) with the fixed id `ALIA_GEMIE_ID`
  (`01a1cf00-cecf-7a24-868b-42b452105a6f`), public. It is **not listed** (`is_published = false`)
  until her Oxy account exists: a catalogue or `searchAgents` card with no name would be a visible
  regression. Being public is what makes her usable by everybody; listing is a separate question
  (ADR 0020 §1), and the migration that writes her account publishes her.
- **Her Oxy account does not exist yet.** Oxy reserves the username `alia` and models her as the
  actor `{ type: 'alia', ownerAccountId }`, which its schema requires to have no account. Until Oxy
  creates the gemie's account (phase 2, Oxy's contract), the row's `oxy_account_id` holds
  `ALIA_PENDING_OXY_ACCOUNT_ID`, a value Oxy resolves to nobody (`POST /users/by-ids` drops it,
  availability answers "anywhere", nobody holds `act_as` over it). This was chosen over a nullable
  column, which would have made every gemie's account optional for the sake of one row; the value
  is replaced by id in the migration that follows Oxy's change.
- **The Oxy lane stays as it is at the edge.** `lib/gemie-oxy-actor.ts` is the one place that
  chooses Oxy's actor for a gemie: `reach = 'person'` speaks `{ type: 'alia', ownerAccountId }`,
  every other gemie `{ type: 'agent', accountId }`. When Oxy accepts `agent:<alia>`, that function
  and Alia's `oxy_account_id` are what change.
- **The public wire does not change in this step.** Responses, the shared page and the email-alert
  settings spell Alia's gemie as no `agentId` (`publicAgentId`), and a request that names no gemie
  gets hers, so a chat with Alia looks and behaves as before. The routes and events take the Gemies
  vocabulary in their own phase, with `@gemies/sdk`.
- **Rows rewritten in POST (0136), not pre.** The replaced image reads Alia's id as an ordinary
  public agent's; rewritten before it drains, every Alia conversation it served would come back with
  her id, the app would send it with the next turn, and that image would answer as a nameless agent
  with no Nilo memory and the person's Oxy apps refused (Oxy knows no such account), start her tasks
  as failing agent sessions, make her answer reactions and read switched-off email alerts as on. So
  during the rollout the new image reads both spellings — a `NULL` conversation gemie is already what
  the wire calls Alia, and three readers say so explicitly, marked "rollout window only"
  (`actorSelectionOf`, the standing lane's run in `alia-task-run`/`alia-task-reaper`,
  `isEmailAlertEnabled`/`listEmailAlertPreferences`) — and the post phase of the same release
  leaves only the new one. Rewritten: `conversations.agent_id` (groups and space rooms included: a
  room belongs to her gemie, `ROOM_GEMIE_ID`, and its speakers stay its `conversation_members`),
  `voice_calls.agent_id`, the system bots' `bots.agent_id` (a user's bot with no agent is unbound,
  not Alia's, and stays so), the feedback on her replies (`message_reaction_states.target_actor_id`),
  `actor_mode = 'alia'` tasks (now `fixed` on her gemie), the standing lane's runs and steps, and
  `email_alert_preferences` / `email_outreach_decisions`. `messages.agent_info_*` is not rewritten:
  a `NULL` there means "the conversation's own gemie spoke". 0137–0139 make
  `conversations.agent_id` NOT NULL (CHECK NOT VALID, VALIDATE, SET NOT NULL), the two email
  columns NOT NULL, and narrow `actor_mode` to `fixed` | `automatic`. What remains for the replaced
  image in the window is a conversation, task or switch the NEW image created during those
  minutes: it names her id, which the old image misreads if a request about it reaches it.
- **Guarantees, tested** (`lib/__tests__/alia-gemie-guarantees.test.ts`,
  `db/__tests__/aliaGemieMigration.pgdb.test.ts`): her memory never reaches another gemie (tools
  or prompt); consulting stays one level deep for her and for a persona; her chat keeps the person
  lane, no `self_*`, no machine, the person's skills and no remit; she is in no catalogue or search
  result while unlisted; the window reads and the post rewrite.
- **Kept, by name, for the vocabulary phase:** the standing lane's stored value
  (`automation_runs.selected_actor_type = 'alia'`, `automation_steps.actor_type`), the `alia-tasks`
  queue and `alia_task_authorizations`.
- **Not yet done:** the Codea gemie is not seeded; the default gemie is Alia for everybody until the
  per-person and per-app setting (§4) exists; the three "rollout window only" reads are dead once
  this release's post phase has run, and are deleted by the next change that touches them.
