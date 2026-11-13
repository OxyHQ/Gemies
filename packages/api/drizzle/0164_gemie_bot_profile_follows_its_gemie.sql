-- oxy:deploy-phase=pre
--
-- ADR 0037, amended: a gemie bot's profile follows its gemie by itself. The columns the sync keeps
-- (`profile_dirty_at`, `profile_sync_after`, attempts, the last failure, the key of the photo it
-- last uploaded) and the index of the bots that are behind. New nullable columns on a small table
-- (1 gemie bot in production when this was written).
ALTER TABLE "bots" ADD COLUMN "profile_dirty_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "profile_sync_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "profile_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "profile_sync_error" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "profile_photo_key" text;--> statement-breakpoint
CREATE INDEX "bots_profile_due_idx" ON "bots" USING btree ("profile_sync_after") WHERE "bots"."profile_dirty_at" is not null;