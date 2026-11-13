-- oxy:deploy-phase=post
--
-- ADR 0035: Signal is no longer a channel, so `conversations.source` no longer admits `signal`.
-- Post, because the image being replaced registers the Signal channel until it has drained. Its own
-- migration, apart from 0142's data work: `conversations` is a hot table, and the swap holds its
-- ACCESS EXCLUSIVE lock only for the instant the two statements take. The new CHECK is added NOT
-- VALID (it scans nothing) and 0144 validates it. Production held 0 `signal` conversations when this
-- was written.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_source_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_source_check" CHECK ("conversations"."source" in ('app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack')) NOT VALID;
