-- oxy:deploy-phase=post
--
-- Gemies acts for people on its own first-party authority (oxy ADR 0066): Oxy's own services never
-- ask a person for tasks, grants or consent, so Gemies keeps none. This drops what only held them:
--
--  - `alia_task_authorizations`, `automation_action_authorizations`: execution authorizations
--    provisioned with the owner's bearer when a task was saved. A run's scope is built when it runs
--    and each call is authorized as it is made.
--  - `agent_work_authorities`, `agent_work_revocations`: a gemie's standing task for its attention,
--    and the outbox that revoked released tasks. Its attention is the gemie's own setting.
--  - every `oxy_task_*` column: agent sessions, agent work items, connected accounts, system bot
--    links and gemie bots. A channel is its person's while it stays connected or linked.
--
-- POST: the image being replaced reads and writes all of it until it has drained; the new image
-- reads and writes none of it. 0181 (pre) already let a work item exist without a task.
--
-- No CASCADE: an unexpected dependent object must abort the migration instead of being removed.
--
-- ## LOCKS
--
-- DROP TABLE and DROP COLUMN are catalogue changes (no rewrite) under ACCESS EXCLUSIVE on each
-- table in turn, held only for the statement: the four dropped tables nothing reads any more, then
-- `agent_sessions`, `agent_work_items`, `bot_users`, `bots` and `connected_accounts`.
DROP TABLE "alia_task_authorizations";--> statement-breakpoint
DROP TABLE "automation_action_authorizations";--> statement-breakpoint
DROP TABLE "agent_work_revocations";--> statement-breakpoint
DROP TABLE "agent_work_authorities";--> statement-breakpoint
DROP INDEX "agent_work_authority_idx";--> statement-breakpoint
ALTER TABLE "agent_work_items" DROP COLUMN "oxy_task_id";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "oxy_task_id";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "oxy_task_retired_at";--> statement-breakpoint
ALTER TABLE "bot_users" DROP COLUMN "oxy_task_id";--> statement-breakpoint
ALTER TABLE "bot_users" DROP COLUMN "oxy_task_state";--> statement-breakpoint
ALTER TABLE "bot_users" DROP COLUMN "oxy_task_expires_at";--> statement-breakpoint
ALTER TABLE "bot_users" DROP COLUMN "oxy_task_notified_at";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "oxy_task_id";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "oxy_task_state";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "oxy_task_expires_at";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "oxy_task_notified_at";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oxy_task_id";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oxy_task_state";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oxy_task_expires_at";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oxy_task_notified_at";
