-- oxy:deploy-phase=post
--
-- The post half of 0156: a connected account names no gemie of its own any more. Post, because the
-- image being replaced reads and writes `agent_id` until it has drained.
--
--  1. An account the old image linked after 0156 ran is granted to its gemie too, which answers it
--     unless the person already chose another (a grant written by the new image is never changed).
--  2. `agent_id`, its index and its foreign key go.
--  3. The `messaging` capability family is retired: the account tools are granted per account, by
--     its person (`connected_account_grants`), and `sendTelegramMessage` with them, so a family
--     switch over them would grant nothing. It is dropped from every gemie's grants, as 0071 did for
--     `shell` and `files` (`RETIRED_CAPABILITY_FAMILIES`). Four rows held it when this was written.
--
-- Production held 0 connected accounts when this was written.
INSERT INTO "connected_account_grants" ("account_id", "agent_id", "answers")
SELECT "ca"."id", "ca"."agent_id", NOT EXISTS (
  SELECT 1 FROM "connected_account_grants" AS "g"
  WHERE "g"."account_id" = "ca"."id" AND "g"."answers"
)
FROM "connected_accounts" AS "ca"
WHERE "ca"."agent_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_agent_id_agents_id_fk";--> statement-breakpoint
DROP INDEX "connected_accounts_agent_user_idx";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "agent_id";--> statement-breakpoint
UPDATE "agents" SET "capability_grants" = array_remove("capability_grants", 'messaging')
WHERE 'messaging' = ANY("capability_grants");
