-- oxy:deploy-phase=pre
--
-- Connectors are providers' own remote MCP servers, a person may connect several accounts of one, and
-- each shows its real logo. The pre half: only additive, nothing the image being replaced reads or
-- writes changes.
--
--  1. `connector_logos` holds every logo Gemies serves (`GET /mcp/logos/:id`), keyed by the SHA-256 of
--     its bytes; `mcp_registry_logos` names the logo of each catalogue entry and where it was read.
--  2. `mcp_servers.account_label` says which of the person's accounts a connection is, and
--     `mcp_servers.logo_id` the server's own icon (`serverInfo.icons`).
--  3. `mcp_oauth_states.registry_id` names the catalogue entry a NEW account is connecting (its row is
--     written when the flow completes), and `return_to` where the callback sends the person back.
--     `return_to` is nullable here because the image being replaced still writes states without it;
--     0155 makes it NOT NULL once that image has drained. The logo foreign key on `mcp_servers` is
--     added NOT VALID (every `logo_id` is NULL) and validated in 0155.
CREATE TABLE "connector_logos" (
	"id" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "connector_logos_content_type_check" CHECK ("connector_logos"."content_type" in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/svg+xml')),
	CONSTRAINT "connector_logos_size_check" CHECK (octet_length("connector_logos"."bytes") between 1 and 262144)
);
--> statement-breakpoint
CREATE TABLE "mcp_registry_logos" (
	"registry_id" text PRIMARY KEY NOT NULL,
	"logo_id" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mcp_registry_logos_source_check" CHECK ("mcp_registry_logos"."source" in ('server', 'mcp_registry', 'website'))
);
--> statement-breakpoint
ALTER TABLE "mcp_registry_logos" ADD CONSTRAINT "mcp_registry_logos_logo_id_connector_logos_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."connector_logos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD COLUMN "registry_id" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD COLUMN "return_to" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "account_label" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "logo_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_logo_id_connector_logos_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."connector_logos"("id") ON DELETE set null ON UPDATE no action NOT VALID;
