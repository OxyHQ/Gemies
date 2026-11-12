-- oxy:deploy-phase=pre
-- oxy:statement-timeout=900s
--
-- ADR 0034 §2: Alia is one official, global gemie — an `agents` row everybody uses — and the rows
-- that spelled her as a `null` agent now name it.
--
-- ## The row
--
-- Matched by its fixed id (`ALIA_GEMIE_ID` in `domain/alia-gemie.ts`), never by name or handle, and
-- inserted only if absent, so running this twice changes nothing. What made Alia different is the
-- configuration 0134 added: her memory is Nilo's, she reaches whatever the person has, she has no
-- mailbox, and her tasks run under standing authority on `alia-tasks`. She has no `computer` (nor its
-- `browser`) grant: no machine. Public and published, as ADR 0034 says.
--
-- `oxy_account_id` is NOT her Oxy account yet. Oxy turns its coordinator lane into the Alia gemie's
-- account in its own contract (ADR 0034 phase 2), and nothing in this repository or its configuration
-- names that account today. Until a later migration writes it (by this id), the row holds a value Oxy
-- resolves to nobody (`ALIA_PENDING_OXY_ACCOUNT_ID`); nothing sends it to Oxy as authority, because
-- Alia's Oxy calls go through the person lane (`lib/gemie-oxy-actor.ts`) and she has no mailbox.
-- `owner_oxy_account_id` stays null for the same reason.
--
-- ## The rows that named her as `null`
--
--  - `conversations.agent_id`: every one, groups and space rooms included. A conversation belongs to a
--    gemie (ADR 0034 §1) and a group's speakers are its `conversation_members`, which is what every
--    reader tells a group by; `agent_id` never was. 0136–0139 make the column NOT NULL.
--  - `voice_calls.agent_id`: a call with no agent was a call with Alia.
--  - `bots.agent_id`: ONLY the system bots (no `user_id`), which Alia answers. A user's bot with no
--    agent is a bot nobody was bound to — it answers nothing — and stays unbound.
--  - `message_reaction_states.target_actor_id`: the feedback on Alia's own replies, so the actor it
--    names agrees with `coalesce(agent_info_id, conversations.agent_id)` from now on.
--  - `automation_definitions`: `actor_mode = 'alia'` becomes `fixed` on Alia's gemie.
--  - `automation_runs` and `automation_steps` of the standing lane name her gemie too, so a run
--    queued before the cut is still driven by `lib/alia-task-run.ts`, which reads the gemie off the
--    run. The lane keeps its stored name (`selected_actor_type = 'alia'`) until the vocabulary
--    migration renames tables and values (ADR 0034 consequences).
--
-- `messages.agent_info_*` is not rewritten: NULL there never meant Alia. It means "the conversation's
-- own gemie spoke", which now resolves through `conversations.agent_id`; the columns snapshot ANOTHER
-- speaker (a consulted gemie, a group member, an agent writing first).
--
-- ## The rolling window
--
-- PRE, so the image being replaced reads these rows for the minutes of the rollout. It reads Alia's id
-- as an ordinary public agent's, so a conversation it serves in that window may be answered by the row
-- as an agent and a task it dispatches may start as an agent session; 0136 rewrites the `null`s it
-- writes meanwhile. Keeping the rewrite in post instead would need the new image to read both
-- spellings, which is the compatibility reader this cut does not keep.
--
-- ## LOCKS
--
-- No ALTER that takes ACCESS EXCLUSIVE: VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, and the rest
-- is row-level DML. The `conversations` rewrite can be large, hence the statement timeout above.
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_memory_store_check";--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_reach_check";--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_task_authority_check";--> statement-breakpoint
INSERT INTO "agents" (
  "id",
  "oxy_account_id",
  "owner_oxy_account_id",
  "character",
  "tagline",
  "description",
  "author_oxy_user_id",
  "category",
  "capability_grants",
  "is_published",
  "access",
  "status",
  "memory_store",
  "reach",
  "mailbox",
  "task_authority"
) VALUES (
  '01a1cf00-cecf-7a24-868b-42b452105a6f',
  'pending-oxy-account:alia',
  NULL,
  '{"preset":"blue_beret","accessory":"none","color":"orchid"}'::jsonb,
  'Oxy''s assistant, the same one for everybody.',
  'Alia answers, remembers you in Nilo, runs your tasks and works in your Oxy apps for you. She can ask any other gemie you can open.',
  'pending-oxy-account:alia',
  'assistant',
  ARRAY['web', 'artifacts', 'memory', 'messaging', 'automation', 'delegation', 'agent']::text[],
  true,
  'public',
  'active',
  'nilo',
  'person',
  false,
  'standing'
) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "conversations" SET "agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f' WHERE "agent_id" IS NULL;--> statement-breakpoint
UPDATE "voice_calls" SET "agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f' WHERE "agent_id" IS NULL;--> statement-breakpoint
UPDATE "bots" SET "agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f' WHERE "agent_id" IS NULL AND "user_id" IS NULL;--> statement-breakpoint
UPDATE "message_reaction_states" AS s
SET "target_actor_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f'
FROM "messages" AS m, "conversations" AS c
WHERE s."target_actor_id" IS NULL
  AND m."oxy_user_id" = s."oxy_user_id"
  AND m."conversation_id" = s."conversation_id"
  AND coalesce(m."client_message_id", m."id") = s."message_id"
  AND m."role" = 'assistant'
  AND m."agent_info_id" IS NULL
  AND c."oxy_user_id" = s."oxy_user_id"
  AND c."conversation_id" = s."conversation_id"
  AND c."agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f';--> statement-breakpoint
UPDATE "automation_definitions"
SET "actor_mode" = 'fixed', "fixed_agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f', "updated_at" = now()
WHERE "actor_mode" = 'alia';--> statement-breakpoint
UPDATE "automation_runs" SET "selected_agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f'
WHERE "selected_actor_type" = 'alia' AND "selected_agent_id" IS NULL;--> statement-breakpoint
UPDATE "automation_steps" SET "agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f'
WHERE "actor_type" = 'alia' AND "agent_id" IS NULL;
