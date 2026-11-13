-- oxy:deploy-phase=pre
--
-- ADR 0037, amendment: a gemie's own bot recognises the person who connected it.
--
--  - `bots.linked_telegram_user_id`: the Telegram account that person proved is theirs, with a
--    one-time `/start <code>` link from the gemie's editor (`link_code_hash`, sha256, and
--    `link_code_expires_at`). Only their private messages from it are their turns.
--  - `bots.oxy_task_id`: the durable Oxy task they granted the gemie for those turns (they are the
--    effective account, the gemie the actor), minted with their session when they link it.
--
-- Nullable columns only: the image being replaced reads and writes none of them. `bots` has one
-- row in production.
ALTER TABLE "bots" ADD COLUMN "linked_telegram_user_id" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "link_code_hash" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "link_code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "oxy_task_id" text;