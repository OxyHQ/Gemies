-- oxy:deploy-phase=post
--
-- Validates the CHECKs 0148 added NOT VALID, now that 0149 has made every external agent `local`.
-- SHARE UPDATE EXCLUSIVE: it blocks neither reads nor writes of `agents` while it scans.
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_identity_source_check";--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_identity_check";--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_local_identity_check";
