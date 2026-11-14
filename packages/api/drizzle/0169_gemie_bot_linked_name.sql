-- oxy:deploy-phase=pre
--
-- ADR 0037: how the bot's person's Telegram showed itself when it linked, for the editor. A new
-- nullable column on a small table.
ALTER TABLE "bots" ADD COLUMN "linked_telegram_name" text;