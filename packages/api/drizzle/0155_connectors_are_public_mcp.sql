-- oxy:deploy-phase=post
--
-- The post half of 0154: every connector is a provider's own remote MCP server, reached over the
-- network; nothing of ours talks to a provider's API, and nothing is started as a process. Post,
-- because the image being replaced still reads and writes what this removes until it has drained.
--
--  1. Command (`stdio`) connectors go: they ran only through a desktop relay that no published client
--     ever shipped. A registry connector that was installed and never connected goes too: a catalogue
--     connector's row is now written when its OAuth completes. A `stopped` one (the retired stop
--     route) becomes `error`, which the app offers to reconnect. `github-remote` is now `github`.
--  2. The hand-written Google and Microsoft integrations go with their tables (`integrations`,
--     `oauth_states`); the providers' own MCP servers replace them (Microsoft 365 through Work IQ;
--     Google's are a Developer Preview a public app may not use yet). `integration:*` grants go from
--     `agents.capability_grants`; the family is retired (`domain/capability-grants.ts`).
--  3. The columns of the device relay and of the stdio command go (`runtime`, `config_command`,
--     `config_args`, `config_env`, `enabled`), with `icon`, which the logos replace. `transport`
--     admits only network transports, and a registry row must name its entry.
--  4. The logo foreign key 0154 added NOT VALID is validated.
--  5. An OAuth state without a return target was written by the replaced image and cannot finish
--     here; it is dropped, and `return_to` becomes NOT NULL.
--
-- Production held, when this was written: 1 connector (Notion, installed and never connected), no
-- command connector, 0 integrations, 0 OAuth states, and no agent with an `integration` or `mcp` grant.
DELETE FROM "mcp_servers" WHERE "transport" = 'stdio';--> statement-breakpoint
DELETE FROM "mcp_servers" WHERE "source" = 'registry' AND "status" = 'installed';--> statement-breakpoint
DELETE FROM "mcp_servers" WHERE "source" = 'registry' AND "registry_id" IS NULL;--> statement-breakpoint
UPDATE "mcp_servers" SET "status" = 'error', "status_message" = 'Reconnect this connector' WHERE "status" = 'stopped';--> statement-breakpoint
UPDATE "mcp_servers" SET "registry_id" = 'github' WHERE "registry_id" = 'github-remote';--> statement-breakpoint
UPDATE "mcp_servers" SET "registry_id" = NULL WHERE "source" = 'custom';--> statement-breakpoint
UPDATE "agents"
SET "capability_grants" = ARRAY(
  SELECT "grant" FROM unnest("capability_grants") AS "grant"
  WHERE "grant" <> 'integration' AND "grant" NOT LIKE 'integration:%'
)
WHERE EXISTS (
  SELECT 1 FROM unnest("capability_grants") AS "grant"
  WHERE "grant" = 'integration' OR "grant" LIKE 'integration:%'
);--> statement-breakpoint
DELETE FROM "mcp_oauth_states" WHERE "return_to" IS NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ALTER COLUMN "return_to" SET NOT NULL;--> statement-breakpoint
DROP TABLE "integrations";--> statement-breakpoint
DROP TABLE "oauth_states";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_runtime_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_command_runs_locally_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_transport_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_status_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "icon";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "runtime";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "config_command";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "config_args";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "config_env";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_registry_check" CHECK (("mcp_servers"."source" = 'registry') = ("mcp_servers"."registry_id" is not null));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" in ('sse', 'streamable-http'));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_status_check" CHECK ("mcp_servers"."status" in ('installed', 'running', 'error'));--> statement-breakpoint
ALTER TABLE "mcp_servers" VALIDATE CONSTRAINT "mcp_servers_logo_id_connector_logos_id_fk";
