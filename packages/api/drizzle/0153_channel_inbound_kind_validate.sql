-- oxy:deploy-phase=post
--
-- Validates the CHECK 0152 added NOT VALID. SHARE UPDATE EXCLUSIVE: it blocks neither reads nor
-- writes of `channel_inbound` while it scans.
ALTER TABLE "channel_inbound" VALIDATE CONSTRAINT "channel_inbound_kind_check";
