-- oxy:deploy-phase=pre
--
-- ADR 0043: a computer is paired once and serves a gemie per CLI; the links one pairing made share
-- a machine id. A nullable column and an index on `external_agent_links`, a small table no request
-- path holds: the image being replaced neither reads nor writes the column.
--
-- ## LOCKS
--
-- ADD COLUMN without a default is a catalogue change; CREATE INDEX takes SHARE on the table, which
-- blocks writes to it (pairing, a daemon connecting) for the build of an index over a few thousand
-- rows at most.
ALTER TABLE "external_agent_links" ADD COLUMN "machine_id" text;--> statement-breakpoint
CREATE INDEX "external_agent_links_machine_idx" ON "external_agent_links" USING btree ("machine_id");