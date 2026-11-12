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
4. Infrastructure. **Done 2026-11-12:** the backend's deploys moved here and left `OxyHQ/Alia` in
   the same window (oxy-infra runbook 65), and `api.gemies.ai` serves the same target group as
   `api.alia.onl`. Still to do: rename ECS, SSM, ECR and Terraform.
5. `@gemies/sdk` 1.0 and `@gemies/server` 1.0, then one PR per consuming repository.
6. The Gemies app (new bundle, `gemies.ai`).
7. `OxyHQ/Alia` reduced to its single-gemie app.
8. `api.alia.onl` removed.

Since 2026-11-12 this repository deploys the backend, and backend changes are made here only.
`OxyHQ/Alia` keeps its app, OTA, Android and the `@alia.onl/*` releases until phase 7.

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
