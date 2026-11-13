-- oxy:deploy-phase=post
--
-- ADR 0037: the MTProto (GramJS) Telegram gateway is gone, and with it the tables it synced into.
-- It never ran in production (it needed TELEGRAM_API_ID/TELEGRAM_API_HASH, which were never set):
-- production held 0 rows in each when this was written. Post, so the image being replaced is
-- not reading them mid-way.
DROP TABLE "telegram_chats";--> statement-breakpoint
DROP TABLE "telegram_messages";--> statement-breakpoint
DROP TABLE "telegram_sessions";