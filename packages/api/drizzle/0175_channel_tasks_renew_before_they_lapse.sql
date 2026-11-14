-- oxy:deploy-phase=pre
--
-- A channel's Oxy task (a connected account's, a system bot link's, a gemie bot's person's) is
-- renewed before it lapses, and its person is told once when it needs them
-- (`lib/channel-task-authority.ts`). Additive: nullable columns, and on `bots` the state the other
-- two tables already have (a constant default, so no rewrite). The image being replaced reads and
-- writes none of them.
--
--  - `oxy_task_expires_at`: when Oxy said the task lapses. A task minted before this was stored is
--    dated by the earliest it can lapse: every channel task was minted for 365 days
--    (`lib/oxy-task-authority.ts` since it existed), after its row was created and after its column
--    existed (0107 for `bot_users` and `connected_accounts`, 2026-10-23; 0163 for `bots`,
--    2026-11-13). A bound that may come early only renews early; it never lets one lapse unseen.
--  - `oxy_task_notified_at`: when the person was told it needs them; cleared with each new task.
--  - `bots.oxy_task_state`: a gemie bot that holds a task holds it `active`, as every channel did.
ALTER TABLE "bot_users" ADD COLUMN "oxy_task_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_users" ADD COLUMN "oxy_task_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "oxy_task_state" text DEFAULT 'reauth_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "oxy_task_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "oxy_task_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "oxy_task_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "oxy_task_notified_at" timestamp with time zone;--> statement-breakpoint
UPDATE "bots" SET "oxy_task_state" = 'active' WHERE "oxy_task_id" IS NOT NULL;--> statement-breakpoint
UPDATE "bots"
SET "oxy_task_expires_at" = greatest("created_at", '2026-11-13T00:00:00Z'::timestamptz) + interval '365 days'
WHERE "oxy_task_id" IS NOT NULL;--> statement-breakpoint
UPDATE "bot_users"
SET "oxy_task_expires_at" = greatest("created_at", '2026-10-23T00:00:00Z'::timestamptz) + interval '365 days'
WHERE "oxy_task_id" IS NOT NULL;--> statement-breakpoint
UPDATE "connected_accounts"
SET "oxy_task_expires_at" = greatest("created_at", '2026-10-23T00:00:00Z'::timestamptz) + interval '365 days'
WHERE "oxy_task_id" IS NOT NULL;
