-- oxy:deploy-phase=pre
--
-- ADR 0039: the audit of an external agent's MCP tool lane. One row per call to /mcp/agents/:id —
-- the tool, the risk the governance gave it, the outcome and the duration; never its arguments or
-- result. Swept after 90 days (db/expiryTargets.ts). Pre phase: a new table nothing reads yet.
CREATE TABLE "external_agent_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"risk_level" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "external_agent_tool_calls_risk_check" CHECK ("external_agent_tool_calls"."risk_level" in ('R0', 'R1', 'R2', 'R3')),
	CONSTRAINT "external_agent_tool_calls_outcome_check" CHECK ("external_agent_tool_calls"."outcome" in ('ok', 'error', 'blocked'))
);
--> statement-breakpoint
CREATE INDEX "external_agent_tool_calls_agent_idx" ON "external_agent_tool_calls" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "external_agent_tool_calls_created_idx" ON "external_agent_tool_calls" USING btree ("created_at");