-- oxy:deploy-phase=pre
--
-- ADR 0043: a session opened from the app with an external agent names the folder it works in. A
-- new table, so nothing running reads or writes it before this release.
CREATE TABLE "external_agent_sessions" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"cwd" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "external_agent_sessions_agent_idx" ON "external_agent_sessions" USING btree ("agent_id","created_at");