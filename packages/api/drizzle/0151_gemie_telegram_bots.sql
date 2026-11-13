-- oxy:deploy-phase=pre
--
-- ADR 0037: Telegram on its official Bot API.
--
--  - `connected_accounts.status` takes `paused` (the person turned the bot off in Telegram ›
--    Telegram Business; it comes back by itself when they turn it on again), and `can_reply`
--    stores whether Telegram lets the gemie write from the account. The CHECK only widens, so the
--    image being replaced writes nothing it refuses; it is added NOT VALID and 0152 validates it.
--  - `bots.group_replies` (mentions | never): what a gemie's own bot does in a Telegram group. A
--    gemie has at most one bot of its own per platform (`bots_agent_platform_key`; a system bot
--    names Alia's gemie with no owner, and is not one).
--
-- `connected_accounts` and `bots` are small (0 and 1 rows in production when this was written).
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_status_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_status_check" CHECK ("connected_accounts"."status" in ('qr-pending', 'connected', 'disconnected', 'paused', 'logged-out', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "can_reply" boolean;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "group_replies" text DEFAULT 'mentions' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_group_replies_check" CHECK ("bots"."group_replies" in ('mentions', 'never')) NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_agent_platform_key" ON "bots" USING btree ("agent_id","platform") WHERE "bots"."agent_id" is not null and "bots"."user_id" is not null;
