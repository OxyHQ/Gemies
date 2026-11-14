-- oxy:deploy-phase=pre
--
-- The connectors store gains a second source, Docker's MCP catalogue (github.com/docker/mcp-registry,
-- MIT): `mcp_catalogue_entries.source` admits `docker`, and `mcp_registry_logos.source` admits a logo
-- read from a Docker catalogue entry. Both checks only widen, so the image being replaced, which writes
-- neither value, is unaffected. Both tables are small (a few thousand rows, written by one job).
ALTER TABLE "mcp_catalogue_entries" DROP CONSTRAINT "mcp_catalogue_entries_source_check";--> statement-breakpoint
ALTER TABLE "mcp_registry_logos" DROP CONSTRAINT "mcp_registry_logos_source_check";--> statement-breakpoint
ALTER TABLE "mcp_catalogue_entries" ADD CONSTRAINT "mcp_catalogue_entries_source_check" CHECK ("mcp_catalogue_entries"."source" in ('mcp_registry', 'docker'));--> statement-breakpoint
ALTER TABLE "mcp_registry_logos" ADD CONSTRAINT "mcp_registry_logos_source_check" CHECK ("mcp_registry_logos"."source" in ('server', 'mcp_registry', 'docker', 'website'));