-- oxy:deploy-phase=post
--
-- ADR 0035, the post half of 0141: every connected account names the gemie it belongs to, and Gmail
-- and Signal are gone. Post, because the image being replaced still reads and writes the columns this
-- drops (and still creates accounts with no gemie) until it has drained.
--
--  1. Gmail and Signal accounts are deleted. The integrations service this release ships has no
--     Gmail or Signal adapter, so no session of theirs runs any more.
--  2. Every other account gets its gemie: the one `auto_reply_agent_id` named, when that row still
--     exists and is one the person could run unattended (their own, or a public active one — the
--     rule a channel turn is authorised by now, `lib/automation-actors.ts`); otherwise Alia's
--     (`ALIA_GEMIE_ID`, seeded by 0135), who answered every account until now: nothing ever read
--     `auto_reply_agent_id`.
--  3. The foreign key 0141 added NOT VALID is validated, and `agent_id` becomes NOT NULL (a small
--     table: both scan it briefly). The columns nothing reads any more go: Gmail's (`email`, the
--     OAuth group and its pair CHECK) and the per-account settings no turn ever honoured
--     (`auto_reply`, `auto_reply_agent_id`, `custom_context`, `allowed_tools`, `blocked_tools`,
--     `allowed_skill_ids`).
--  4. `connected_accounts.platform` is CHECKed to WhatsApp and Telegram, and `notifications.channels`
--     no longer admits `whatsapp`, `discord` or `slack`, which were delivered through a connected
--     account of the person's and which no notification ever named. (`conversations.source` loses
--     `signal` in 0143, apart: it is a hot table.)
--
-- Production held 0 connected accounts and 0 notifications on those channels when this was written.
DELETE FROM "connected_accounts" WHERE "platform" NOT IN ('whatsapp', 'telegram');--> statement-breakpoint
UPDATE "connected_accounts" AS "ca"
SET "agent_id" = COALESCE(
  (
    SELECT "a"."id" FROM "agents" AS "a"
    WHERE "a"."id" = "ca"."auto_reply_agent_id"
      AND ("a"."owner_oxy_account_id" = "ca"."oxy_user_id"
        OR ("a"."access" = 'public' AND "a"."status" = 'active'))
  ),
  '01a1cf00-cecf-7a24-868b-42b452105a6f'
)
WHERE "ca"."agent_id" IS NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" VALIDATE CONSTRAINT "connected_accounts_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_oauth_pair_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_channels_check";--> statement-breakpoint
DROP INDEX "connected_accounts_oxy_user_platform_idx";--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "auto_reply";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "auto_reply_agent_id";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "custom_context";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "allowed_tools";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "blocked_tools";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "allowed_skill_ids";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oauth_access_token";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oauth_refresh_token";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oauth_expires_at";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "oauth_scope";--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_platform_check" CHECK ("connected_accounts"."platform" in ('whatsapp', 'telegram'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channels_check" CHECK ("notifications"."channels" <@ ARRAY['push', 'telegram', 'in_app']::text[]);
