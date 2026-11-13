-- oxy:deploy-phase=pre
--
-- ADR 0035, amended: who a gemie answers on a connected account, and one status vocabulary with
-- the integrations gateway.
--
--  - `replies` (everyone | chosen | nobody), `reply_chat_ids` (the chats `chosen` answers) and
--    `group_replies` (never | mentions). The defaults are what every account did until now in a
--    direct chat (answer it); in a group it answered every message, which nobody would choose for
--    their own WhatsApp, so a group is answered only when it mentions or replies to the account.
--  - `status` takes the gateway's vocabulary (`GEMIE_ACCOUNT_STATUSES`: qr-pending, connected,
--    disconnected, logged-out, failed). The API used to drop every status it did not share with
--    the gateway, so an account unlinked from the phone stayed `connected` here forever. The CHECK
--    is widened to both vocabularies for the rollout (the image being replaced writes
--    `connecting`); 0146 (post) rewrites the old values and narrows it.
--  - `account_id` loses NOT NULL: the new image does not write it, and 0146 drops it.
--
-- `connected_accounts` is small (0 rows in production when this was written).
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_status_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "status" SET DEFAULT 'qr-pending';--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "replies" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "reply_chat_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "group_replies" text DEFAULT 'mentions' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_replies_check" CHECK ("connected_accounts"."replies" in ('everyone', 'chosen', 'nobody'));--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_group_replies_check" CHECK ("connected_accounts"."group_replies" in ('never', 'mentions'));--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_status_check" CHECK ("connected_accounts"."status" in ('qr-pending', 'connected', 'disconnected', 'logged-out', 'failed', 'connecting', 'error', 'expired'));