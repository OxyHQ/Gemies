-- oxy:deploy-phase=post
--
-- Bloom 21.3.1 draws a picture's background as a much lighter tint of the colour for light colours
-- too (a lime stood on a dark olive). The photo is uploaded only when its key changes, so every
-- gemie bot forgets its key and takes its profile once more. Post, so the drawing that syncs is the
-- one serving.
UPDATE "bots" SET "profile_photo_key" = NULL, "profile_dirty_at" = date_trunc('milliseconds', now()), "profile_sync_after" = now()
WHERE "platform" = 'telegram' AND "agent_id" IS NOT NULL AND "user_id" IS NOT NULL;
