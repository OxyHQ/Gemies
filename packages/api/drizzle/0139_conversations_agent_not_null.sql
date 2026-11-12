-- oxy:deploy-phase=post
--
-- ADR 0034: the last step of the cut.
--
--  - A task no longer has an `alia` actor mode: 0135/0136 made every such task `fixed` on Alia's gemie,
--    so the CHECK narrows to the two modes the image reads.
--  - `conversations.agent_id` is NOT NULL. 0138 validated `conversations_agent_id_present`, from which
--    PostgreSQL 12+ proves SET NOT NULL without scanning the table, so the ACCESS EXCLUSIVE lock on the
--    hot table lasts an instant; the helper CHECK is then redundant and dropped. The `conversations`
--    statements come last, so that lock is held for the shortest part of this transaction.
ALTER TABLE "automation_definitions" DROP CONSTRAINT "automation_definitions_actor_mode_check";--> statement-breakpoint
ALTER TABLE "automation_definitions" ADD CONSTRAINT "automation_definitions_actor_mode_check" CHECK ("automation_definitions"."actor_mode" in ('fixed', 'automatic'));--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_agent_id_present";
