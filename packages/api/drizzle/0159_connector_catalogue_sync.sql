-- oxy:deploy-phase=pre
--
-- The connectors store grows from the official MCP Registry. Only additive: two new tables nothing
-- in the image being replaced reads.
--
--  1. `mcp_catalogue_entries` holds every remote MCP server synced from the registry, with where it
--     came from (`source`, `upstream_name`, `upstream_version`), its sanitised listing, its badge
--     (`trust`), how a person signs in (`auth`) and its health check. The store offers a row only while
--     it is listed upstream, healthy and signed in to in a way Gemies supports.
--  2. `mcp_catalogue_sync_state` says where each registry's sync stands, and the last pass's counts.
CREATE TABLE "mcp_catalogue_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"upstream_name" text NOT NULL,
	"upstream_version" text NOT NULL,
	"upstream_updated_at" timestamp with time zone,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"trust" text NOT NULL,
	"url" text NOT NULL,
	"transport" text NOT NULL,
	"website_url" text,
	"repository_url" text,
	"icons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth" text DEFAULT 'unknown' NOT NULL,
	"health" text DEFAULT 'pending' NOT NULL,
	"health_message" text,
	"health_checked_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"tool_count" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_catalogue_entries_source_check" CHECK ("mcp_catalogue_entries"."source" in ('mcp_registry')),
	CONSTRAINT "mcp_catalogue_entries_category_check" CHECK ("mcp_catalogue_entries"."category" in ('productivity', 'development', 'communication', 'data', 'design', 'finance', 'marketing', 'commerce', 'search', 'other')),
	CONSTRAINT "mcp_catalogue_entries_trust_check" CHECK ("mcp_catalogue_entries"."trust" in ('official', 'verified', 'community')),
	CONSTRAINT "mcp_catalogue_entries_transport_check" CHECK ("mcp_catalogue_entries"."transport" in ('sse', 'streamable-http')),
	CONSTRAINT "mcp_catalogue_entries_auth_check" CHECK ("mcp_catalogue_entries"."auth" in ('unknown', 'none', 'oauth', 'needs_provider_app')),
	CONSTRAINT "mcp_catalogue_entries_health_check" CHECK ("mcp_catalogue_entries"."health" in ('pending', 'healthy', 'failing')),
	CONSTRAINT "mcp_catalogue_entries_https_check" CHECK ("mcp_catalogue_entries"."url" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE "mcp_catalogue_sync_state" (
	"source" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"last_error" text,
	"last_report" jsonb,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalogue_entries_source_name_key" ON "mcp_catalogue_entries" USING btree ("source","upstream_name");--> statement-breakpoint
CREATE INDEX "mcp_catalogue_entries_health_checked_at_idx" ON "mcp_catalogue_entries" USING btree ("health_checked_at");