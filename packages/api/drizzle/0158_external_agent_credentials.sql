-- oxy:deploy-phase=pre
--
-- ADR 0038: an external agent connects with a credential of its own, not with its owner's Oxy session.
-- `external_agent_links.credential_hash` holds the SHA-256 of that credential; it is null only on a link
-- paired before this, which the relay still opens with the owner's Oxy session until it is reconnected.
-- `external_agent_pairings.agent_id` names the agent a reconnect code replaces the credential of.
--
-- Pre phase: two nullable columns, which the image being replaced neither reads nor writes.
ALTER TABLE "external_agent_links" ADD COLUMN "credential_hash" text;--> statement-breakpoint
ALTER TABLE "external_agent_pairings" ADD COLUMN "agent_id" text;
