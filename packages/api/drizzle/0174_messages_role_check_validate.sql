-- oxy:deploy-phase=post
-- oxy:statement-timeout=900s
--
-- Validates the CHECK 0173 added NOT VALID. SHARE UPDATE EXCLUSIVE: it blocks neither reads nor
-- writes of `messages` while it scans.
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_role_check";
