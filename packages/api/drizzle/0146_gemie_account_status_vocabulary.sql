-- oxy:deploy-phase=post
--
-- The post half of 0145, once the image that wrote the old vocabulary has drained:
--
--  - the old statuses are rewritten (`connecting` was a link waiting for its scan: `qr-pending`;
--    `error` and `expired` were never written by any code, and would mean a link to make again:
--    `failed`), and the CHECK narrows to the gateway's vocabulary;
--  - the columns nothing reads go: `account_id` (the phone number is `phone_number`),
--    `avatar_url` and `status_message` (never written), `capabilities` (a constant nobody read)
--    and `metadata` (never written or read).
--
-- `connected_accounts` is small (0 rows in production when this was written).
UPDATE "connected_accounts" SET "status" = 'qr-pending' WHERE "status" = 'connecting';--> statement-breakpoint
UPDATE "connected_accounts" SET "status" = 'failed' WHERE "status" IN ('error', 'expired');--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_status_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "avatar_url";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "status_message";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "capabilities";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_status_check" CHECK ("connected_accounts"."status" in ('qr-pending', 'connected', 'disconnected', 'logged-out', 'failed'));
