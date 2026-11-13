-- oxy:deploy-phase=post
-- oxy:statement-timeout=900s
--
-- Validates the CHECK 0143 added NOT VALID. SHARE UPDATE EXCLUSIVE: it blocks neither reads nor
-- writes of `conversations` while it scans.
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_source_check";
