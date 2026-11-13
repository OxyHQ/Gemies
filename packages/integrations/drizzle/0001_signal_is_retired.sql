-- oxy:deploy-phase=post
--
-- ADR 0035: Signal is no longer a platform a gemie can be linked to, and this release's image has
-- no Signal adapter. Post, because the image being replaced still restores and runs Signal sessions
-- from these tables until it has drained. Production held 0 Signal sessions, chats and messages
-- when this was written.
DROP TABLE "signal_chats" CASCADE;--> statement-breakpoint
DROP TABLE "signal_messages" CASCADE;--> statement-breakpoint
DROP TABLE "signal_sessions" CASCADE;
