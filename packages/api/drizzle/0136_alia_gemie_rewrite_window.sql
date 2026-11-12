-- oxy:deploy-phase=post
-- oxy:statement-timeout=900s
--
-- ADR 0034 §2, after the rollout: the image 0135 ran beside kept writing Alia as a `null` agent until
-- it was drained. Post runs once it is gone, so this rewrites exactly what it wrote in the window, with
-- the same rules as 0135 (only system bots; feedback on Alia's own replies; `alia` tasks become `fixed`
-- on her gemie). Nothing writes a `null` agent for Alia after this: the image that runs now names her.
--
-- Data only, so 0137 can take its instant ACCESS EXCLUSIVE lock on the hot `conversations` table in
-- a migration of its own.
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
