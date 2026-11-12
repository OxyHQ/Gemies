-- oxy:deploy-phase=post
-- oxy:statement-timeout=900s
--
-- ADR 0034 §2: the rows that spelled Alia as a `null` agent now name her gemie (seeded by 0135).
--
-- ## Why POST, not pre
--
-- The image being replaced reads Alia's id as an ordinary public agent's. Rewritten in pre, every
-- existing Alia conversation would come back from it with `agentId: <her id>` for the minutes of the
-- rollout: the app would send that id with the next turn, and the old image would answer it as an
-- agent — its remit prompt with no name, an agent session and thread, its own memory instead of
-- Nilo's, and the person's Oxy apps refused (Oxy knows no account `pending-oxy-account:alia`). Its
-- dispatcher would start her tasks as agent sessions that fail the same way, its reaction engine
-- would make her answer reactions, and switches set off would read as on.
--
-- So the rewrite waits until the old image is drained. Meanwhile the image that runs reads both
-- spellings: a NULL conversation gemie is already what the public wire calls Alia, and the three
-- readers that need it say so (`actorSelectionOf`, the standing lane's run, `isEmailAlertEnabled`).
-- Post runs in the same release; after it no NULL is left, and 0139 makes the columns NOT NULL.
--
-- ## What is rewritten
--
--  - `conversations.agent_id`: every NULL, groups and space rooms included. A conversation belongs to
--    a gemie (ADR 0034 §1); a room belongs to hers (`ROOM_GEMIE_ID`) and its speakers stay its
--    `conversation_members`, which is what every reader tells a group by.
--  - `voice_calls.agent_id`: a call with no agent was a call with Alia.
--  - `bots.agent_id`: ONLY the system bots (no `user_id`), which Alia answers. A user's bot with no
--    agent is a bot nobody was bound to — it answers nothing — and stays unbound.
--  - `message_reaction_states.target_actor_id`: the feedback on Alia's own replies, so the actor it
--    names agrees with `coalesce(agent_info_id, conversations.agent_id)` from now on.
--  - `automation_definitions`: `actor_mode = 'alia'` becomes `fixed` on Alia's gemie.
--  - `automation_runs` and `automation_steps` of the standing lane name her gemie too. The lane keeps
--    its stored name (`selected_actor_type = 'alia'`) until the vocabulary migration.
--  - `email_alert_preferences` and `email_outreach_decisions`: NULL meant the person's own Inbox, told
--    by Alia; it names her gemie.
--
-- `messages.agent_info_*` is not rewritten: NULL there never meant Alia. It means "the conversation's
-- own gemie spoke", which resolves through `conversations.agent_id`; the columns snapshot ANOTHER
-- speaker (a consulted gemie, a group member, an agent writing first).
--
-- Data only, so 0137 can take its instant ACCESS EXCLUSIVE lock on the hot `conversations` table in
-- a migration of its own. The `conversations` rewrite can be large, hence the statement timeout.
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
WHERE "actor_type" = 'alia' AND "agent_id" IS NULL;--> statement-breakpoint
-- A person with a NULL switch AND (set during the rollout) one on her id keeps the newer.
DELETE FROM "email_alert_preferences" AS p
USING "email_alert_preferences" AS q
WHERE p."agent_id" IS NULL
  AND q."agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f'
  AND q."oxy_user_id" = p."oxy_user_id";--> statement-breakpoint
UPDATE "email_alert_preferences" SET "agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f' WHERE "agent_id" IS NULL;--> statement-breakpoint
UPDATE "email_outreach_decisions" SET "agent_id" = '01a1cf00-cecf-7a24-868b-42b452105a6f' WHERE "agent_id" IS NULL;
