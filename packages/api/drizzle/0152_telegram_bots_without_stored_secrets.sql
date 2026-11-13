-- oxy:deploy-phase=post
--
-- ADR 0037, once the image that used them has drained:
--
--  - a bot's webhook secret is derived from its id by the integrations process and never stored,
--    so `bots.webhook_secret` (and its lookup index) goes, with `platform_config_webhook_url` and
--    `platform_config_public_key`, which nothing reads;
--  - a gemie's own bot is answered through the integrations process, not the API's channel
--    queue, so `channel_inbound` loses the `agent_bot` kind (0 such rows in production when this
--    was written; any left by the old image are dropped, it could no longer answer them). The new
--    CHECK is NOT VALID; 0153 validates it;
--  - the CHECKs 0151 added NOT VALID are validated.
DELETE FROM "channel_inbound" WHERE "kind" = 'agent_bot';--> statement-breakpoint
ALTER TABLE "channel_inbound" DROP CONSTRAINT "channel_inbound_kind_check";--> statement-breakpoint
ALTER TABLE "channel_inbound" ADD CONSTRAINT "channel_inbound_kind_check" CHECK ("channel_inbound"."kind" in ('system')) NOT VALID;--> statement-breakpoint
DROP INDEX "bots_webhook_secret_idx";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "webhook_secret";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "platform_config_webhook_url";--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "platform_config_public_key";--> statement-breakpoint
ALTER TABLE "connected_accounts" VALIDATE CONSTRAINT "connected_accounts_status_check";--> statement-breakpoint
ALTER TABLE "bots" VALIDATE CONSTRAINT "bots_group_replies_check";
