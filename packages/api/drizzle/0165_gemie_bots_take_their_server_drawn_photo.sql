-- oxy:deploy-phase=post
--
-- Every gemie bot takes its gemie's profile once more, now with the photo the server draws (the
-- editor used to draw it). Post, so the image that syncs is the one serving.
UPDATE "bots" SET "profile_dirty_at" = date_trunc('milliseconds', now()), "profile_sync_after" = now()
WHERE "platform" = 'telegram' AND "agent_id" IS NOT NULL AND "user_id" IS NOT NULL;
